// SMS two-factor via Twilio Verify: phone enrollment + consent, enabling SMS as
// the method, the login challenge (correct / wrong / attempt cap), resend, and
// the magic-link SMS gate. The outbound Twilio Verify HTTP calls are mocked
// (mirroring how _setup.ts spies Resend's fetch); Twilio "owns" the code, so the
// mock treats a fixed CORRECT_CODE as approved and everything else as pending.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  dbRun,
  dbGet,
  env,
  extractToken,
  type SeededUser,
} from './_setup';

const CORRECT_CODE = '123456';

// ─── Twilio Verify + Resend capture ──────────────────────────────────────────

interface SmsCapture {
  starts: { to: string }[];
  checks: { to: string; code: string }[];
  emails: { to: string; text: string; html: string }[];
  /** Force the NEXT Verifications POST to return this Twilio error, then clear. */
  nextStartError: { status: number; code: number } | null;
  restore(): void;
}

function setupSmsCapture(): SmsCapture {
  const cap: SmsCapture = {
    starts: [],
    checks: [],
    emails: [],
    nextStartError: null,
    restore: () => spy.mockRestore(),
  };
  const original = globalThis.fetch;
  const spy: MockInstance = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      const params = new URLSearchParams(bodyStr);

      if (url.includes('verify.twilio.com') && url.endsWith('/Verifications')) {
        if (cap.nextStartError) {
          const e = cap.nextStartError;
          cap.nextStartError = null;
          return new Response(JSON.stringify({ code: e.code, message: 'twilio error' }), {
            status: e.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const to = params.get('To') ?? '';
        cap.starts.push({ to });
        return new Response(JSON.stringify({ sid: 'VEtest', status: 'pending', to, channel: 'sms' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('verify.twilio.com') && url.endsWith('/VerificationCheck')) {
        const to = params.get('To') ?? '';
        const code = params.get('Code') ?? '';
        cap.checks.push({ to, code });
        const approved = code === CORRECT_CODE;
        return new Response(JSON.stringify({ status: approved ? 'approved' : 'pending', valid: approved }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://api.resend.com/emails')) {
        try {
          const parsed = JSON.parse(bodyStr) as { to?: string; text?: string; html?: string };
          cap.emails.push({ to: String(parsed.to ?? ''), text: String(parsed.text ?? ''), html: String(parsed.html ?? '') });
        } catch {
          // ignore malformed body
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return original(input as RequestInfo, init);
    },
  );
  return cap;
}

// ─── Twilio env toggles (mutate the binding, like thumbnail.test.ts) ─────────

type MutableEnv = Record<string, string | undefined>;
function setTwilioEnv(): void {
  (env as MutableEnv).TWILIO_ACCOUNT_SID = 'ACtest';
  (env as MutableEnv).TWILIO_AUTH_TOKEN = 'test-token';
  (env as MutableEnv).TWILIO_VERIFY_SERVICE_SID = 'VAtest';
}
function clearTwilioEnv(): void {
  (env as MutableEnv).TWILIO_ACCOUNT_SID = undefined;
  (env as MutableEnv).TWILIO_AUTH_TOKEN = undefined;
  (env as MutableEnv).TWILIO_VERIFY_SERVICE_SID = undefined;
}

// A signed-in client + the user's seed record.
async function loginNewUser(email: string): Promise<{ client: TestClient; user: SeededUser }> {
  const user = await seedUser({ email });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  expect(res.status).toBe(200);
  return { client, user };
}

// Put a user fully on SMS 2FA (verified phone + method='sms').
async function enableSmsFully(userId: string, phone: string): Promise<void> {
  const now = Date.now();
  await dbRun(
    `UPDATE user SET phone = ?, phone_verified_at = ?, sms_consent_at = ?, sms_consent_ip = '203.0.113.7',
        twofa_method = 'sms', twofa_enrolled_at = ? WHERE id = ?`,
    phone,
    now,
    now,
    now,
    userId,
  );
}

// ─── Unconfigured: SMS is inert without the secrets ──────────────────────────

describe('SMS 2FA — unconfigured (no Twilio secrets)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    clearTwilioEnv();
  });

  it('GET /api/me/twofa reports sms_available:false and the stubs return sms_unavailable', async () => {
    const { client } = await loginNewUser('nosms@example.com');

    const status = (await (await client.get('/api/me/twofa')).json()) as { sms_available: boolean };
    expect(status.sms_available).toBe(false);

    const enable = await client.post('/api/me/twofa/enable', { method: 'sms' });
    expect(enable.status).toBe(400);
    expect((await enable.json() as { error: string }).error).toBe('sms_unavailable');

    const phone = await client.post('/api/me/phone', { phone: '+14065551234' });
    expect(phone.status).toBe(400);
    expect((await phone.json() as { error: string }).error).toBe('sms_unavailable');

    const verify = await client.post('/api/me/phone/verify', { code: '123456' });
    expect(verify.status).toBe(400);
    expect((await verify.json() as { error: string }).error).toBe('sms_unavailable');
  });
});

// ─── Phone enrollment round trip ─────────────────────────────────────────────

describe('SMS 2FA — phone enrollment', () => {
  let capture: SmsCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setTwilioEnv();
    capture = setupSmsCapture();
  });
  afterEach(() => {
    capture.restore();
    clearTwilioEnv();
  });

  it('adds + verifies a phone, storing the number and consent evidence', async () => {
    const { client, user } = await loginNewUser('enroll-phone@example.com');

    const add = await client.post('/api/me/phone', { phone: '+1 (406) 555-1234' });
    expect(add.status).toBe(200);
    expect((await add.json() as { phone_masked: string }).phone_masked).toContain('1234');
    // The number was normalized to E.164 and a code texted to it.
    expect(capture.starts.map((s) => s.to)).toContain('+14065551234');

    const verify = await client.post('/api/me/phone/verify', { code: CORRECT_CODE });
    expect(verify.status).toBe(200);
    expect(capture.checks.at(-1)).toEqual({ to: '+14065551234', code: CORRECT_CODE });

    const row = await dbGet<{ phone: string; phone_verified_at: number | null; sms_consent_at: number | null; sms_consent_ip: string | null }>(
      `SELECT phone, phone_verified_at, sms_consent_at, sms_consent_ip FROM user WHERE id = ?`,
      user.id,
    );
    expect(row?.phone).toBe('+14065551234');
    expect(row?.phone_verified_at).toBeTruthy();
    expect(row?.sms_consent_at).toBeTruthy();
    expect(row?.sms_consent_ip).toBeTruthy();
  });

  it('rejects a malformed number with 400 sms_invalid_phone (no Twilio call)', async () => {
    const { client } = await loginNewUser('badphone@example.com');
    const res = await client.post('/api/me/phone', { phone: 'not a phone' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('sms_invalid_phone');
    expect(capture.starts.length).toBe(0);
  });

  it('maps a Twilio invalid-number error to 400 sms_invalid_phone', async () => {
    const { client } = await loginNewUser('twilio-reject@example.com');
    capture.nextStartError = { status: 400, code: 60200 };
    const res = await client.post('/api/me/phone', { phone: '+15005550001' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('sms_invalid_phone');
  });

  it('a wrong phone code → 400 twofa_invalid_code with attempts_left', async () => {
    const { client } = await loginNewUser('wrong-phone-code@example.com');
    await client.post('/api/me/phone', { phone: '+14065559876' });
    const res = await client.post('/api/me/phone/verify', { code: '000000' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; attempts_left: number };
    expect(body.error).toBe('twofa_invalid_code');
    expect(body.attempts_left).toBe(4);
  });
});

// ─── Enabling SMS as the 2FA method ──────────────────────────────────────────

describe('SMS 2FA — enable as method', () => {
  let capture: SmsCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setTwilioEnv();
    capture = setupSmsCapture();
  });
  afterEach(() => {
    capture.restore();
    clearTwilioEnv();
  });

  it('enabling SMS without a verified phone → 400 sms_phone_required', async () => {
    const { client } = await loginNewUser('sms-nophone@example.com');
    const res = await client.post('/api/me/twofa/enable', { method: 'sms' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('sms_phone_required');
  });

  it('verified phone → enable + confirm turns on SMS 2FA', async () => {
    const { client, user } = await loginNewUser('sms-enable@example.com');

    await client.post('/api/me/phone', { phone: '+14065550000' });
    await client.post('/api/me/phone/verify', { code: CORRECT_CODE });
    const startsAfterEnroll = capture.starts.length;

    const enable = await client.post('/api/me/twofa/enable', { method: 'sms' });
    expect(enable.status).toBe(200);
    const { challenge } = (await enable.json()) as { challenge: string };
    expect(challenge).toBeTruthy();
    // Enabling SMS texts a fresh enroll code to the verified number.
    expect(capture.starts.length).toBe(startsAfterEnroll + 1);
    expect(capture.starts.at(-1)?.to).toBe('+14065550000');

    const confirm = await client.post('/api/me/twofa/confirm', { challenge, code: CORRECT_CODE });
    expect(confirm.status).toBe(200);
    expect((await confirm.json() as { method: string }).method).toBe('sms');

    const status = (await (await client.get('/api/me/twofa')).json()) as { method: string; phone_masked: string | null; sms_available: boolean };
    expect(status.method).toBe('sms');
    expect(status.phone_masked).toContain('0000');
    expect(status.sms_available).toBe(true);

    const row = await dbGet<{ twofa_method: string }>(`SELECT twofa_method FROM user WHERE id = ?`, user.id);
    expect(row?.twofa_method).toBe('sms');
  });
});

// ─── Login challenge over SMS ────────────────────────────────────────────────

describe('SMS 2FA — login challenge', () => {
  let capture: SmsCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setTwilioEnv();
    capture = setupSmsCapture();
  });
  afterEach(() => {
    capture.restore();
    clearTwilioEnv();
  });

  it('challenged login texts a code; wrong code fails, correct code issues a session', async () => {
    const user = await seedUser({ email: 'sms-login@example.com' });
    await enableSmsFully(user.id, '+14065559999');

    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; method: string; challenge: string; destination: string };
    expect(body.error).toBe('twofa_required');
    expect(body.method).toBe('sms');
    expect(body.destination).toContain('9999');
    expect(client.cookie).toBeNull();
    expect(capture.starts.map((s) => s.to)).toContain('+14065559999');

    const wrong = await client.post('/auth/2fa/verify', { challenge: body.challenge, code: '000000' });
    expect(wrong.status).toBe(400);
    expect((await wrong.json() as { error: string }).error).toBe('twofa_invalid_code');
    // Twilio was consulted for the wrong code.
    expect(capture.checks.some((ch) => ch.code === '000000')).toBe(true);

    const ok = await client.post('/auth/2fa/verify', { challenge: body.challenge, code: CORRECT_CODE });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { user: { id: string } }).user.id).toBe(user.id);
    expect(client.cookie).toMatch(/^gb_session=/);

    const me = await client.get('/api/me');
    expect(me.status).toBe(200);
  });

  it('5 wrong SMS codes invalidate the challenge → twofa_expired', async () => {
    const user = await seedUser({ email: 'sms-brute@example.com' });
    await enableSmsFully(user.id, '+14065558888');
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    const { challenge } = (await res.json()) as { challenge: string };

    for (let i = 1; i <= 4; i++) {
      const r = await client.post('/auth/2fa/verify', { challenge, code: '000000' });
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toBe('twofa_invalid_code');
    }
    const fifth = await client.post('/auth/2fa/verify', { challenge, code: '000000' });
    expect(fifth.status).toBe(400);
    expect((await fifth.json() as { error: string }).error).toBe('twofa_expired');
  });

  it('resend starts a new Verify send under the cooldown rules', async () => {
    const user = await seedUser({ email: 'sms-resend@example.com' });
    await enableSmsFully(user.id, '+14065557777');
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    const { challenge } = (await res.json()) as { challenge: string };
    const startsAfterLogin = capture.starts.length;

    const tooSoon = await client.post('/auth/2fa/resend', { challenge });
    expect(tooSoon.status).toBe(429);
    expect((await tooSoon.json() as { error: string }).error).toBe('rate_limited');
    expect(capture.starts.length).toBe(startsAfterLogin);

    await dbRun(`UPDATE twofa_challenge SET last_sent_at = ? WHERE user_id = ?`, Date.now() - 61_000, user.id);
    const resent = await client.post('/auth/2fa/resend', { challenge });
    expect(resent.status).toBe(200);
    expect(capture.starts.length).toBe(startsAfterLogin + 1);

    const ok = await client.post('/auth/2fa/verify', { challenge, code: CORRECT_CODE });
    expect(ok.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
  });
});

// ─── Magic-link gate ─────────────────────────────────────────────────────────

describe('SMS 2FA — magic link', () => {
  let capture: SmsCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    setTwilioEnv();
    capture = setupSmsCapture();
  });
  afterEach(() => {
    capture.restore();
    clearTwilioEnv();
  });

  async function magicToken(client: TestClient, email: string): Promise<string> {
    const req = await client.post('/auth/magic-link/request', { email });
    expect(req.status).toBe(204);
    const mail = capture.emails.filter((e) => e.to === email).at(-1);
    const token = mail ? extractToken(mail.text) ?? extractToken(mail.html) : null;
    if (!token) throw new Error('no magic-link token captured');
    return token;
  }

  it('an SMS-method user is SMS-challenged on magic-link consume (no session yet)', async () => {
    const user = await seedUser({ email: 'sms-magic@example.com' });
    await enableSmsFully(user.id, '+14065551212');
    const client = makeClient();
    const token = await magicToken(client, user.email);

    const res = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    expect(loc).toContain('/login#twofa=');
    expect(loc).toContain('method=sms');
    expect(client.cookie).toBeNull();
    expect(capture.starts.map((s) => s.to)).toContain('+14065551212');
  });

  it('an email-method user still skips 2FA on magic-link consume (signed straight in)', async () => {
    const user = await seedUser({ email: 'email-magic@example.com' });
    await dbRun(`UPDATE user SET twofa_method = 'email', twofa_enrolled_at = ? WHERE id = ?`, Date.now(), user.id);
    const client = makeClient();
    const token = await magicToken(client, user.email);

    const res = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('/?welcome=1');
    expect(client.cookie).toMatch(/^gb_session=/);
    expect(capture.starts.length).toBe(0);
  });
});
