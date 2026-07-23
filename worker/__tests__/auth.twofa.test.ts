// Two-factor authentication: enrollment round trips, the login challenge gate,
// code verification (attempt cap, TTL, resend), org-wide requirement, and the
// PATCH role gate.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  setupEmailCapture,
  dbRun,
  dbGet,
  env,
  type EmailCapture,
  type SeededUser,
} from './_setup';
import { reapExpiredTwofaChallenges } from '../auth/twofa';

// Pull the 6-digit code out of the most recent captured verification email.
function latestCode(capture: EmailCapture, to?: string): string {
  const list = to ? capture.emails.filter((e) => e.to === to) : capture.emails;
  const email = list[list.length - 1];
  if (!email) throw new Error('no captured email');
  const m = email.text.match(/(\d{6})/);
  if (!m) throw new Error(`no 6-digit code in email text: ${email.text}`);
  return m[1];
}

async function enableEmail2fa(userId: string): Promise<void> {
  await dbRun(`UPDATE user SET twofa_method = 'email', twofa_enrolled_at = ? WHERE id = ?`, Date.now(), userId);
}

// Log in a fresh client to the point of the 2FA challenge and return the token.
async function loginToChallenge(user: SeededUser): Promise<{ client: TestClient; challenge: string; body: Record<string, unknown> }> {
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  expect(res.status).toBe(403);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.error).toBe('twofa_required');
  return { client, challenge: String(body.challenge), body };
}

describe('2FA — login unchanged when disabled', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('a user with 2FA off logs in normally (200 + session cookie, no code email)', async () => {
    const user = await seedUser({ email: 'off@example.com' });
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
    expect(capture.emails.length).toBe(0);
  });
});

describe('2FA — enable / confirm round trip', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('enable → email code → confirm turns 2FA on', async () => {
    const user = await seedUser({ email: 'enroll@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const enableRes = await client.post('/api/me/twofa/enable', { method: 'email' });
    expect(enableRes.status).toBe(200);
    const { challenge } = (await enableRes.json()) as { challenge: string };
    expect(challenge).toBeTruthy();

    const code = latestCode(capture, user.email);
    const confirmRes = await client.post('/api/me/twofa/confirm', { challenge, code });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json() as { method: string }).method).toBe('email');

    const statusRes = await client.get('/api/me/twofa');
    const status = (await statusRes.json()) as { method: string; org_required: boolean; sms_available: boolean };
    expect(status.method).toBe('email');
    expect(status.org_required).toBe(false);
    expect(status.sms_available).toBe(false);
  });

  it('enable with method=sms returns 400 sms_unavailable', async () => {
    const user = await seedUser({ email: 'sms-enroll@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    const res = await client.post('/api/me/twofa/enable', { method: 'sms' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('sms_unavailable');
  });

  it('phone enrollment stubs return 400 sms_unavailable', async () => {
    const user = await seedUser({ email: 'phone@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    const p1 = await client.post('/api/me/phone', { phone: '+14065551234' });
    expect(p1.status).toBe(400);
    expect((await p1.json() as { error: string }).error).toBe('sms_unavailable');
    const p2 = await client.post('/api/me/phone/verify', { code: '123456' });
    expect(p2.status).toBe(400);
    expect((await p2.json() as { error: string }).error).toBe('sms_unavailable');
  });
});

describe('2FA — login challenge + verify', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('challenged login sets NO cookie and returns method + masked destination', async () => {
    const user = await seedUser({ email: 'challenge@example.com' });
    await enableEmail2fa(user.id);
    const { client, body } = await loginToChallenge(user);
    expect(client.cookie).toBeNull();
    expect(body.method).toBe('email');
    expect(body.resend_cooldown_sec).toBe(60);
    expect(String(body.destination)).toContain('•••');
  });

  it('verify with the emailed code issues a working session', async () => {
    const user = await seedUser({ email: 'verify@example.com' });
    await enableEmail2fa(user.id);
    const { client, challenge } = await loginToChallenge(user);

    const code = latestCode(capture, user.email);
    const verifyRes = await client.post('/auth/2fa/verify', { challenge, code });
    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json() as { user: { id: string } }).user.id).toBe(user.id);
    expect(client.cookie).toMatch(/^gb_session=/);

    const me = await client.get('/api/me');
    expect(me.status).toBe(200);
    expect((await me.json() as { user: { id: string } }).user.id).toBe(user.id);
  });

  it('5 wrong codes invalidate the challenge → twofa_expired', async () => {
    const user = await seedUser({ email: 'brute@example.com' });
    await enableEmail2fa(user.id);
    const { client, challenge } = await loginToChallenge(user);

    for (let i = 1; i <= 4; i++) {
      const res = await client.post('/auth/2fa/verify', { challenge, code: '000000' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; attempts_left: number };
      expect(body.error).toBe('twofa_invalid_code');
      expect(body.attempts_left).toBe(5 - i);
    }
    // The 5th wrong code kills the challenge.
    const fifth = await client.post('/auth/2fa/verify', { challenge, code: '000000' });
    expect(fifth.status).toBe(400);
    expect((await fifth.json() as { error: string }).error).toBe('twofa_expired');
  });

  it('an expired challenge cannot be verified', async () => {
    const user = await seedUser({ email: 'ttl@example.com' });
    await enableEmail2fa(user.id);
    const { client, challenge } = await loginToChallenge(user);

    await dbRun(`UPDATE twofa_challenge SET expires_at = ? WHERE user_id = ?`, Date.now() - 1000, user.id);
    const res = await client.post('/auth/2fa/verify', { challenge, code: '000000' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('twofa_expired');
  });

  it('an enroll challenge cannot be used on /auth/2fa/verify (purpose isolation)', async () => {
    const user = await seedUser({ email: 'purpose@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    const enableRes = await client.post('/api/me/twofa/enable', { method: 'email' });
    const { challenge } = (await enableRes.json()) as { challenge: string };
    const code = latestCode(capture, user.email);

    const res = await client.post('/auth/2fa/verify', { challenge, code });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('twofa_expired');
  });
});

describe('2FA — resend', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('resend within the cooldown is 429; after cooldown a new code verifies', async () => {
    const user = await seedUser({ email: 'resend@example.com' });
    await enableEmail2fa(user.id);
    const { client, challenge } = await loginToChallenge(user);

    const tooSoon = await client.post('/auth/2fa/resend', { challenge });
    expect(tooSoon.status).toBe(429);
    expect((await tooSoon.json() as { error: string }).error).toBe('rate_limited');

    // Bypass the cooldown window, then resend.
    await dbRun(`UPDATE twofa_challenge SET last_sent_at = ? WHERE user_id = ?`, Date.now() - 61_000, user.id);
    const resent = await client.post('/auth/2fa/resend', { challenge });
    expect(resent.status).toBe(200);
    expect((await resent.json() as { resend_cooldown_sec: number }).resend_cooldown_sec).toBe(60);

    const newCode = latestCode(capture, user.email);
    const verifyRes = await client.post('/auth/2fa/verify', { challenge, code: newCode });
    expect(verifyRes.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);
  });

  it('resend is capped at 3 sends per challenge', async () => {
    const user = await seedUser({ email: 'cap@example.com' });
    await enableEmail2fa(user.id);
    const { client, challenge } = await loginToChallenge(user); // sends = 1

    // Two more resends (sends 2, 3), bypassing the cooldown each time.
    for (let i = 0; i < 2; i++) {
      await dbRun(`UPDATE twofa_challenge SET last_sent_at = ? WHERE user_id = ?`, Date.now() - 61_000, user.id);
      const res = await client.post('/auth/2fa/resend', { challenge });
      expect(res.status).toBe(200);
    }
    // 4th send exceeds the cap.
    await dbRun(`UPDATE twofa_challenge SET last_sent_at = ? WHERE user_id = ?`, Date.now() - 61_000, user.id);
    const over = await client.post('/auth/2fa/resend', { challenge });
    expect(over.status).toBe(429);
    expect((await over.json() as { error: string }).error).toBe('rate_limited');
  });
});

describe('2FA — send rate limit', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('the 6th send in an hour is rate_limited (5/hour per user)', async () => {
    const user = await seedUser({ email: 'ratelimit@example.com' });
    await enableEmail2fa(user.id);

    // Five fresh logins each issue one code (sends 1..5).
    for (let i = 0; i < 5; i++) {
      const client = makeClient();
      const res = await client.post('/auth/login', { email: user.email, password: user.password });
      expect(res.status).toBe(403);
    }
    // The sixth trips the send cap before a code is issued.
    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe('rate_limited');
  });
});

describe('2FA — org-wide requirement', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  async function seedOrgWithRequire2fa(memberId: string, role = 'editor'): Promise<string> {
    const orgId = ulid();
    const now = Date.now();
    await dbRun(
      `INSERT INTO organization (id, slug, name, created_at, plan, plan_status, require_2fa)
       VALUES (?, ?, 'Secure Org', ?, 'agency', 'active', 1)`,
      orgId,
      `secure-${orgId.toLowerCase()}`,
      now,
    );
    await dbRun(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
      orgId,
      memberId,
      role,
      now,
    );
    return orgId;
  }

  it('forces an email challenge for an unenrolled member', async () => {
    const member = await seedUser({ email: 'member@example.com' });
    await seedOrgWithRequire2fa(member.id);

    const { body } = await loginToChallenge(member);
    expect(body.method).toBe('email');
    // A code was actually emailed to the member.
    expect(latestCode(capture, member.email)).toMatch(/^\d{6}$/);
  });

  it('blocks a member from disabling their own 2FA (twofa_org_required)', async () => {
    const member = await seedUser({ email: 'locked@example.com' });
    await enableEmail2fa(member.id);
    await seedOrgWithRequire2fa(member.id);

    // Sign in via the challenge to get a real session.
    const { client, challenge } = await loginToChallenge(member);
    const code = latestCode(capture, member.email);
    await client.post('/auth/2fa/verify', { challenge, code });

    const res = await client.post('/api/me/twofa/disable');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('twofa_org_required');
  });
});

describe('2FA — disable round trip', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('disable → email code → confirm turns 2FA off', async () => {
    const user = await seedUser({ email: 'disable@example.com' });
    await enableEmail2fa(user.id);

    const { client, challenge } = await loginToChallenge(user);
    const loginCode = latestCode(capture, user.email);
    await client.post('/auth/2fa/verify', { challenge, code: loginCode });

    const disableRes = await client.post('/api/me/twofa/disable');
    expect(disableRes.status).toBe(200);
    const { challenge: disableChallenge } = (await disableRes.json()) as { challenge: string };
    const disableCode = latestCode(capture, user.email);

    const confirmRes = await client.post('/api/me/twofa/confirm', { challenge: disableChallenge, code: disableCode });
    expect(confirmRes.status).toBe(200);
    expect((await confirmRes.json() as { method: string }).method).toBe('none');

    const row = await dbGet<{ twofa_method: string }>(`SELECT twofa_method FROM user WHERE id = ?`, user.id);
    expect(row?.twofa_method).toBe('none');
  });
});

describe('2FA — org PATCH require_2fa role gate', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('editor gets 403, admin/owner sets it and it shows in GET', async () => {
    const owner = await seedUser({ email: 'owner@example.com' });
    const ownerClient = makeClient();
    await ownerClient.post('/auth/login', { email: owner.email, password: owner.password });
    const createRes = await ownerClient.post('/api/orgs', { slug: 'gate-org', name: 'Gate Org' });
    expect(createRes.status).toBe(201);
    const orgId = (await createRes.json() as { organization: { id: string } }).organization.id;

    // A second user joined as editor.
    const editor = await seedUser({ email: 'editor@example.com' });
    await dbRun(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'editor', ?)`,
      orgId,
      editor.id,
      Date.now(),
    );
    const editorClient = makeClient();
    await editorClient.post('/auth/login', { email: editor.email, password: editor.password });
    const editorPatch = await editorClient.patch(`/api/orgs/${orgId}`, { require_2fa: true });
    expect(editorPatch.status).toBe(403);

    // Owner can set it.
    const ownerPatch = await ownerClient.patch(`/api/orgs/${orgId}`, { require_2fa: true });
    expect(ownerPatch.status).toBe(200);
    expect((await ownerPatch.json() as { organization: { requireTwofa: boolean } }).organization.requireTwofa).toBe(true);

    const getRes = await ownerClient.get(`/api/orgs/${orgId}`);
    expect((await getRes.json() as { organization: { requireTwofa: boolean } }).organization.requireTwofa).toBe(true);
  });
});

describe('2FA — challenge reaper', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('purges expired + consumed rows, leaves live ones', async () => {
    const user = await seedUser({ email: 'reap@example.com' });
    await enableEmail2fa(user.id);
    const now = Date.now();

    // Live, expired, and consumed challenges.
    await dbRun(
      `INSERT INTO twofa_challenge (id, user_id, token_hash, code_hash, purpose, method, attempts, sends, created_at, expires_at, last_sent_at, consumed_at)
       VALUES (?, ?, ?, 'h', 'login', 'email', 0, 1, ?, ?, ?, NULL)`,
      ulid(), user.id, `live-${ulid()}`, now, now + 600_000, now,
    );
    await dbRun(
      `INSERT INTO twofa_challenge (id, user_id, token_hash, code_hash, purpose, method, attempts, sends, created_at, expires_at, last_sent_at, consumed_at)
       VALUES (?, ?, ?, 'h', 'login', 'email', 0, 1, ?, ?, ?, NULL)`,
      ulid(), user.id, `expired-${ulid()}`, now, now - 1000, now,
    );
    await dbRun(
      `INSERT INTO twofa_challenge (id, user_id, token_hash, code_hash, purpose, method, attempts, sends, created_at, expires_at, last_sent_at, consumed_at)
       VALUES (?, ?, ?, 'h', 'login', 'email', 0, 1, ?, ?, ?, ?)`,
      ulid(), user.id, `consumed-${ulid()}`, now, now + 600_000, now, now,
    );

    const { deleted } = await reapExpiredTwofaChallenges(env);
    expect(deleted).toBe(2);
    const remaining = await dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM twofa_challenge WHERE user_id = ?`, user.id);
    expect(remaining?.n).toBe(1);
  });
});
