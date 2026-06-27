// Google OAuth ("Continue with Google"), issue #20.
//
// Covers: /start redirect + state cookie; callback state-mismatch rejection;
// new-user creation (active + email_verified); existing-email account linking
// (no duplicate); and email_verified=false rejection.
//
// Google's token + userinfo HTTP calls are mocked by spying on globalThis.fetch
// (same approach as setupEmailCapture's Resend mock). SELF.fetch for the worker
// goes through a separate channel and is unaffected.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { makeClient, locationPath, locationQuery } from './_client';
import { applyMigrations, dbAll, dbGet, resetDb, seedUser, type CapturedEmail } from './_setup';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const RESEND = 'https://api.resend.com/emails';

interface GoogleMock {
  /** Identity returned by the userinfo endpoint. */
  identity: { sub: string; email: string; email_verified: boolean | string; name?: string };
  /** When set, the token endpoint returns this status (default 200 + access_token). */
  tokenStatus?: number;
  /** When set, the userinfo endpoint returns this status (default 200). */
  userinfoStatus?: number;
  /** Outbound Resend emails captured during the flow (the welcome send lands here). */
  emails: CapturedEmail[];
  /** When set, Resend calls return this failure instead of success (welcome-send-failure test). */
  failResend?: { status: number; body?: string };
  restore(): void;
}

// A single globalThis.fetch mock that handles Google's token + userinfo calls
// AND captures outbound Resend emails. (We can't layer a second `vi.spyOn` on
// top of setupEmailCapture — spying an already-mocked fetch overwrites rather
// than chains, which self-recurses — so the email capture is folded in here.)
function mockGoogle(identity: GoogleMock['identity']): GoogleMock {
  const self: GoogleMock = { identity, emails: [], restore: () => spy.mockRestore() };
  const original = globalThis.fetch;
  const spy: MockInstance = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(TOKEN)) {
        if (self.tokenStatus && self.tokenStatus !== 200) {
          return new Response('{"error":"invalid_grant"}', { status: self.tokenStatus });
        }
        return new Response(JSON.stringify({ access_token: 'mock-access-token', id_token: 'mock.id.token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith(USERINFO)) {
        if (self.userinfoStatus && self.userinfoStatus !== 200) {
          return new Response('{}', { status: self.userinfoStatus });
        }
        return new Response(JSON.stringify(self.identity), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith(RESEND)) {
        if (self.failResend) {
          return new Response(self.failResend.body ?? '', { status: self.failResend.status });
        }
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        try {
          const parsed = JSON.parse(bodyStr) as CapturedEmail;
          self.emails.push({
            to: String(parsed.to ?? ''),
            from: String(parsed.from ?? ''),
            subject: String(parsed.subject ?? ''),
            html: String(parsed.html ?? ''),
            text: String(parsed.text ?? ''),
            ...(parsed.reply_to != null ? { reply_to: String(parsed.reply_to) } : {}),
            ...(parsed.bcc != null ? { bcc: String(parsed.bcc) } : {}),
          });
        } catch {
          // ignore malformed body
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return original(input as RequestInfo, init);
    },
  );
  return self;
}

// The callback emits TWO Set-Cookie headers (clear gb_oauth_state + the new
// gb_session). makeClient only auto-tracks the first, so pull the session
// cookie out explicitly and inject it for subsequent same-session requests.
function sessionCookieFrom(res: Response): string | null {
  const all = res.headers.getSetCookie?.() ?? [];
  const joined = all.join('\n');
  const m = joined.match(/gb_session=([^;\s]+)/);
  return m ? m[1] : null;
}

// Drive /start, capture the state token + cookie, then build the callback URL.
async function startFlow(client: ReturnType<typeof makeClient>, next?: string) {
  const startPath = next ? `/auth/google/start?next=${encodeURIComponent(next)}` : '/auth/google/start';
  const start = await client.get(startPath);
  expect(start.status).toBe(302);
  const loc = start.headers.get('Location')!;
  expect(loc.startsWith(AUTH)).toBe(true);
  const state = new URL(loc).searchParams.get('state')!;
  // makeClient already captured the Set-Cookie into client.cookie.
  return { state, redirectTo: new URL(loc) };
}

describe('auth /google', () => {
  let g: GoogleMock | null = null;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  afterEach(() => {
    g?.restore();
    g = null;
  });

  const welcomeEmails = () =>
    (g?.emails ?? []).filter((e) => e.subject.startsWith('Welcome to GTFS·X'));

  it('/start redirects to Google with the right params and sets a state cookie', async () => {
    const client = makeClient();
    const start = await client.get('/auth/google/start');
    expect(start.status).toBe(302);

    const loc = new URL(start.headers.get('Location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(AUTH);
    expect(loc.searchParams.get('client_id')).toBe('test-google-client-id');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://127.0.0.1/auth/google/callback');
    expect(loc.searchParams.get('response_type')).toBe('code');
    expect(loc.searchParams.get('scope')).toBe('openid email profile');
    expect(loc.searchParams.get('access_type')).toBe('online');
    expect(loc.searchParams.get('prompt')).toBe('select_account');
    const state = loc.searchParams.get('state');
    expect(state).toBeTruthy();

    // httpOnly + Secure + SameSite=Lax state cookie, scoped to /auth/google.
    const setCookie = start.headers.get('Set-Cookie')!;
    expect(setCookie).toMatch(/^gb_oauth_state=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/auth/google');
  });

  it('callback with a mismatched state is rejected (CSRF)', async () => {
    g = mockGoogle({ sub: 'g-1', email: 'csrf@example.com', email_verified: true });
    const client = makeClient();
    await startFlow(client); // sets the cookie

    // Use a wrong state value in the query while keeping the cookie.
    const cb = await client.get('/auth/google/callback?code=abc&state=not-the-real-state');
    expect(cb.status).toBe(302);
    expect(locationPath(cb)).toBe('/login');
    expect(locationQuery(cb, 'error')).toBe('google');
    // No session established.
    expect(client.cookie).not.toMatch(/gb_session=/);
  });

  it('callback with no state cookie is rejected', async () => {
    g = mockGoogle({ sub: 'g-x', email: 'nocookie@example.com', email_verified: true });
    const client = makeClient();
    // Never call /start, so there is no cookie.
    const cb = await client.get('/auth/google/callback?code=abc&state=whatever', { noCookie: true });
    expect(cb.status).toBe(302);
    expect(locationQuery(cb, 'error')).toBe('google');
  });

  it('new user: creates an active, email_verified account and signs in', async () => {
    g = mockGoogle({ sub: 'g-new-1', email: 'New.User@Example.com', email_verified: true, name: 'New User' });
    const client = makeClient();
    const { state } = await startFlow(client, '/feeds');

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    // Lands on the signed `next`.
    expect(locationPath(cb)).toBe('/feeds');
    const sess = sessionCookieFrom(cb);
    expect(sess).toBeTruthy();
    client.setCookie(`gb_session=${sess}`);

    const user = await dbGet<{ id: string; email: string; status: string; email_verified: number }>(
      `SELECT id, email, status, email_verified FROM user WHERE email = ?`,
      'new.user@example.com',
    );
    expect(user).toBeTruthy();
    expect(user!.status).toBe('active');
    expect(user!.email_verified).toBe(1);

    // The Google identity was bound via a credential row.
    const creds = await dbAll<{ kind: string; oauth_provider: string; oauth_subject: string }>(
      `SELECT kind, oauth_provider, oauth_subject FROM credential WHERE user_id = ?`,
      user!.id,
    );
    expect(creds).toHaveLength(1);
    expect(creds[0].kind).toBe('google_oauth');
    expect(creds[0].oauth_provider).toBe('google');
    expect(creds[0].oauth_subject).toBe('g-new-1');

    // Session resolves to the new user.
    const meRes = await client.get('/api/me');
    const me = await client.json<{ user: { id: string } }>(meRes);
    expect(me.user.id).toBe(user!.id);
  });

  it('existing email: links the Google identity instead of creating a duplicate (BE-16)', async () => {
    const existing = await seedUser({ email: 'linkme@example.com', status: 'active' });
    g = mockGoogle({ sub: 'g-link-1', email: 'linkme@example.com', email_verified: true });
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(locationPath(cb)).toBe('/');
    const sess = sessionCookieFrom(cb);
    expect(sess).toBeTruthy();
    client.setCookie(`gb_session=${sess}`);

    // Still exactly one user with that email — no duplicate.
    const users = await dbAll<{ id: string }>(`SELECT id FROM user WHERE email = ?`, 'linkme@example.com');
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(existing.id);

    // The original password credential is still there, plus a new google_oauth one.
    const creds = await dbAll<{ kind: string }>(
      `SELECT kind FROM credential WHERE user_id = ? ORDER BY kind`,
      existing.id,
    );
    const kinds = creds.map((c) => c.kind).sort();
    expect(kinds).toEqual(['google_oauth', 'password']);

    // Signed in as the existing user.
    const meRes = await client.get('/api/me');
    const me = await client.json<{ user: { id: string } }>(meRes);
    expect(me.user.id).toBe(existing.id);
  });

  it('SECURITY: linking to an unverified (pending) account drops its password credential (pre-hijacking)', async () => {
    // Attack: a squatter pre-creates a password account on the victim's email
    // and leaves it pending (can't verify — no inbox access). When the real
    // owner signs in with Google, we must NOT keep the squatter's password,
    // or the squatter could log in to the now-active account.
    const squatter = await seedUser({ email: 'victim@example.com', status: 'pending_verification' });
    g = mockGoogle({ sub: 'g-hijack-1', email: 'victim@example.com', email_verified: true, name: 'Real Owner' });
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);

    // Same user, now active — no duplicate.
    const users = await dbAll<{ id: string; status: string }>(
      `SELECT id, status FROM user WHERE email = ?`,
      'victim@example.com',
    );
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(squatter.id);
    expect(users[0].status).toBe('active');

    // The squatter's password credential is GONE; only the Google link remains.
    const creds = await dbAll<{ kind: string }>(
      `SELECT kind FROM credential WHERE user_id = ?`,
      squatter.id,
    );
    expect(creds.map((c) => c.kind).sort()).toEqual(['google_oauth']);
  });

  it('returning user: a known Google sub signs in without creating another credential', async () => {
    // First login creates the user + credential.
    g = mockGoogle({ sub: 'g-return-1', email: 'returner@example.com', email_verified: true });
    const first = makeClient();
    const { state: s1 } = await startFlow(first);
    await first.get(`/auth/google/callback?code=abc&state=${s1}`);

    const user = await dbGet<{ id: string }>(`SELECT id FROM user WHERE email = ?`, 'returner@example.com');
    expect(user).toBeTruthy();

    // Second login with the same sub.
    const second = makeClient();
    const { state: s2 } = await startFlow(second);
    const cb = await second.get(`/auth/google/callback?code=abc&state=${s2}`);
    expect(cb.status).toBe(302);
    expect(sessionCookieFrom(cb)).toBeTruthy();

    // Still one user, one google credential.
    const users = await dbAll(`SELECT id FROM user WHERE email = ?`, 'returner@example.com');
    expect(users).toHaveLength(1);
    const googleCreds = await dbAll(
      `SELECT id FROM credential WHERE user_id = ? AND kind = 'google_oauth'`,
      user!.id,
    );
    expect(googleCreds).toHaveLength(1);
  });

  it('new OAuth user gets exactly one welcome email with reply_to and NO owner bcc', async () => {
    g = mockGoogle({ sub: 'g-welcome-1', email: 'gwelcome@example.com', email_verified: true, name: 'G Welcome' });
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);

    const welcomes = welcomeEmails();
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].to).toBe('gwelcome@example.com');
    expect(welcomes[0].reply_to).toBe('hello@gtfsx.com');
    // Owner is no longer BCC'd per-signup — replaced by the daily owner digest.
    expect(welcomes[0].bcc).toBeUndefined();
  });

  it('existing user linking Google gets NO welcome email', async () => {
    await seedUser({ email: 'glink@example.com', status: 'active' });
    g = mockGoogle({ sub: 'g-link-welcome', email: 'glink@example.com', email_verified: true });
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    // Link path — not a brand-new user — so no welcome.
    expect(welcomeEmails()).toHaveLength(0);
  });

  it('returning OAuth user (known sub) gets NO welcome on a later sign-in', async () => {
    g = mockGoogle({ sub: 'g-return-welcome', email: 'greturn@example.com', email_verified: true });
    const first = makeClient();
    const { state: s1 } = await startFlow(first);
    await first.get(`/auth/google/callback?code=abc&state=${s1}`);
    // First sign-in is the brand-new user → one welcome.
    expect(welcomeEmails()).toHaveLength(1);

    const second = makeClient();
    const { state: s2 } = await startFlow(second);
    const cb = await second.get(`/auth/google/callback?code=abc&state=${s2}`);
    expect(cb.status).toBe(302);
    // Returning user → still just the one welcome from the first sign-in.
    expect(welcomeEmails()).toHaveLength(1);
  });

  it('a failing welcome send does not break new-OAuth-user signup (active + session)', async () => {
    g = mockGoogle({ sub: 'g-wfail', email: 'gwfail@example.com', email_verified: true });
    g.failResend = { status: 500, body: '{"error":"boom"}' };
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(sessionCookieFrom(cb)).toBeTruthy();

    const user = await dbGet<{ status: string }>(
      `SELECT status FROM user WHERE email = ?`,
      'gwfail@example.com',
    );
    expect(user?.status).toBe('active');
  });

  it('rejects when Google reports email_verified=false (no account, no session)', async () => {
    g = mockGoogle({ sub: 'g-unverified', email: 'unverified@example.com', email_verified: false });
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(locationPath(cb)).toBe('/login');
    expect(locationQuery(cb, 'error')).toBe('google');
    expect(client.cookie).not.toMatch(/gb_session=/);

    // No user was created.
    const users = await dbAll(`SELECT id FROM user WHERE email = ?`, 'unverified@example.com');
    expect(users).toHaveLength(0);
  });

  it('rejects when Google denies (callback carries ?error)', async () => {
    g = mockGoogle({ sub: 'g-deny', email: 'deny@example.com', email_verified: true });
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?error=access_denied&state=${state}`);
    expect(cb.status).toBe(302);
    expect(locationQuery(cb, 'error')).toBe('google');
    expect(client.cookie).not.toMatch(/gb_session=/);
  });

  it('rejects when the token exchange fails', async () => {
    g = mockGoogle({ sub: 'g-tok', email: 'tok@example.com', email_verified: true });
    g.tokenStatus = 400;
    const client = makeClient();
    const { state } = await startFlow(client);

    const cb = await client.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(locationQuery(cb, 'error')).toBe('google');
  });
});
