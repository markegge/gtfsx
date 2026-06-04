import { Hono } from 'hono';
import { ulid } from 'ulidx';
import type { AppContext } from '../env';
import { generateToken } from '../util/crypto';
import { clientIp } from '../util/rateLimit';
import { logAudit } from '../util/audit';
import { createSession, sessionCookie } from './session';

// ─── Google OAuth: server-side authorization-code flow (issue #20) ───────────
//
// Two endpoints, both GET (full-page redirect flow — not fetch/XHR):
//
//   GET /auth/google/start    → 302 to Google's consent screen.
//   GET /auth/google/callback → Google redirects here with ?code&state.
//
// CSRF: /start mints a random `state`, stores it in a short-lived httpOnly +
// Secure + SameSite=Lax cookie, and includes it in the Google URL. /callback
// requires the query `state` to equal the cookie before doing anything else; a
// mismatch (or missing cookie) is rejected. The `next` post-login path is
// folded into the state cookie value (state + '.' + base64url(next)) so a
// tampered query string can't redirect the user off to an attacker path — the
// only `next` we honor is the one we ourselves signed into the cookie.
//
// Identity: we exchange the code for tokens at Google's token endpoint, then
// read the verified identity from the userinfo endpoint using the returned
// access token. We REQUIRE `email_verified === true` from Google before
// trusting the email; otherwise the request is rejected (an unverified Google
// email could be an address the user doesn't actually control, which would let
// them hijack an existing GTFS·X account by email match).
//
// Account model: the Google identity (its stable `sub`) is bound via the
// existing `credential` table (kind='google_oauth'). On callback:
//   1. Known `sub` → sign that user in.
//   2. Else, verified email matches an existing user → LINK (insert the
//      google_oauth credential) and sign in. No duplicate account (BE-16).
//   3. Else → create a fresh active, email_verified user + credential, sign in.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const STATE_COOKIE = 'gb_oauth_state';
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes to complete the round-trip.

export const googleRouter = new Hono<AppContext>();

function redirectUri(origin: string): string {
  return `${origin}/auth/google/callback`;
}

// Validate a post-login redirect path: a same-origin relative path only. Same
// rules as authRouter.safeNext — reject anything that could resolve to another
// host or smuggle control chars into a Location header.
function safeNext(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith('/')) return undefined;
  if (raw.startsWith('//')) return undefined;
  if (raw.length > 512) return undefined;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return raw;
}

function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  try {
    return decodeURIComponent(escape(atob(norm + pad)));
  } catch {
    return '';
  }
}

// The cookie payload binds the CSRF token to the (already-validated) next path
// so the callback can't be tricked into honoring an attacker-supplied next.
function packState(token: string, next: string | undefined): string {
  return next ? `${token}.${b64urlEncode(next)}` : token;
}
function unpackState(value: string): { token: string; next: string | undefined } {
  const dot = value.indexOf('.');
  if (dot === -1) return { token: value, next: undefined };
  const token = value.slice(0, dot);
  const next = safeNext(b64urlDecode(value.slice(dot + 1)));
  return { token, next };
}

function stateCookie(value: string): string {
  return `${STATE_COOKIE}=${value}; Max-Age=${STATE_TTL_SECONDS}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax`;
}
function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Max-Age=0; Path=/auth/google; HttpOnly; Secure; SameSite=Lax`;
}
function readStateCookie(req: Request): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === STATE_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

// Constant-time-ish compare for the state token. Lengths are fixed (43-char
// base64url) in practice; bail fast on length mismatch, otherwise XOR-fold.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── /auth/google/start ──────────────────────────────────────────────────────
googleRouter.get('/start', (c) => {
  const origin = c.env.APP_ORIGIN;
  const clientId = c.env.GOOGLE_CLIENT_ID;
  // Misconfiguration (no client id) → bounce to the login error page rather
  // than emitting a broken Google URL. Never leak which piece is missing.
  if (!clientId) {
    return c.redirect(`${origin}/login?error=google`, 302);
  }

  const next = safeNext(c.req.query('next'));
  const token = generateToken();
  const cookieValue = packState(token, next);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    state: token,
    access_type: 'online',
    prompt: 'select_account',
  });

  c.header('Set-Cookie', stateCookie(cookieValue));
  // Don't let intermediaries cache the consent redirect.
  c.header('Cache-Control', 'no-store');
  return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
});

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

interface UserRow {
  id: string;
  email: string;
  status: string;
  deleted_at: number | null;
}

// ─── /auth/google/callback ────────────────────────────────────────────────────
googleRouter.get('/callback', async (c) => {
  const origin = c.env.APP_ORIGIN;
  const ip = clientIp(c.req.raw);
  const fail = () => {
    c.header('Set-Cookie', clearStateCookie());
    return c.redirect(`${origin}/login?error=google`, 302);
  };

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail();

  // Google denial (user clicked "cancel") or any provider-side error.
  if (c.req.query('error')) return fail();

  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  if (!code || !stateParam) return fail();

  // CSRF: the query state must match the token we stored in the cookie.
  const cookieRaw = readStateCookie(c.req.raw);
  if (!cookieRaw) return fail();
  const { token: expectedToken, next } = unpackState(cookieRaw);
  if (!timingSafeEqual(stateParam, expectedToken)) return fail();

  // ─── Exchange the code for tokens ──────────────────────────────────────────
  let tokenJson: { access_token?: string; id_token?: string };
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(origin),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) return fail();
    tokenJson = await tokenRes.json();
  } catch {
    return fail();
  }
  if (!tokenJson.access_token) return fail();

  // ─── Resolve identity via the userinfo endpoint ────────────────────────────
  let info: GoogleUserInfo;
  try {
    const infoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    if (!infoRes.ok) return fail();
    info = await infoRes.json();
  } catch {
    return fail();
  }

  const sub = typeof info.sub === 'string' ? info.sub : '';
  const email = typeof info.email === 'string' ? info.email.trim().toLowerCase() : '';
  // Google may serialize email_verified as a boolean or the string "true".
  const emailVerified = info.email_verified === true || info.email_verified === 'true';
  const displayName =
    typeof info.name === 'string' && info.name.trim().length > 0
      ? info.name.trim().slice(0, 120)
      : email.split('@')[0] || 'GTFS·X user';

  if (!sub || !email) return fail();
  // SECURITY: never trust an email Google hasn't itself verified — otherwise a
  // user could claim an address they don't own and link/hijack an account.
  if (!emailVerified) return fail();

  const now = Date.now();

  // 1) Known Google identity → sign that user in.
  const byCredential = await c.env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.status AS status, u.deleted_at AS deleted_at
       FROM credential cr JOIN user u ON u.id = cr.user_id
      WHERE cr.oauth_provider = 'google' AND cr.oauth_subject = ?
      LIMIT 1`,
  )
    .bind(sub)
    .first<UserRow>();

  let userId: string;
  let auditAction: string;

  if (byCredential) {
    if (byCredential.deleted_at || byCredential.status === 'deleted_soft' || byCredential.status === 'disabled') {
      return fail();
    }
    userId = byCredential.id;
    auditAction = 'session.login';
  } else {
    // 2) Existing user with this verified email → LINK (BE-16), don't duplicate.
    const byEmail = await c.env.DB.prepare(
      `SELECT id, email, status, deleted_at FROM user WHERE email = ? LIMIT 1`,
    )
      .bind(email)
      .first<UserRow>();

    if (byEmail) {
      if (byEmail.deleted_at || byEmail.status === 'deleted_soft' || byEmail.status === 'disabled') {
        return fail();
      }
      userId = byEmail.id;

      // SECURITY (account pre-hijacking): if this account never verified its own
      // email, it has NOT proven it controls the address — a squatter could have
      // pre-created a password signup on the victim's email and left it pending.
      // Google has now proven ownership, so before activating we drop any
      // untrusted password credential (otherwise the squatter's password would
      // work on the now-active account) and reset the squatter-chosen display
      // name. An account that is already active proved ownership (verify-email
      // link, magic link, or invitation-token possession), so it's the
      // legitimate owner — we keep its password and simply add the Google link.
      if (byEmail.status === 'pending_verification') {
        await c.env.DB.prepare(`DELETE FROM credential WHERE user_id = ? AND kind = 'password'`)
          .bind(userId)
          .run();
        await c.env.DB.prepare(`UPDATE user SET display_name = ? WHERE id = ?`)
          .bind(displayName, userId)
          .run();
      }

      // Link the Google identity. The (oauth_provider, oauth_subject) unique
      // index protects against a duplicate link if two callbacks race.
      await c.env.DB.prepare(
        `INSERT INTO credential (id, user_id, kind, oauth_provider, oauth_subject, created_at, updated_at)
         VALUES (?, ?, 'google_oauth', 'google', ?, ?, ?)`,
      )
        .bind(ulid(), userId, sub, now, now)
        .run();
      // Google verified this address → the account is active + email-verified.
      await c.env.DB.prepare(
        `UPDATE user SET status = 'active', email_verified = 1, updated_at = ? WHERE id = ?`,
      )
        .bind(now, userId)
        .run();
      auditAction = 'user.oauth_linked';
    } else {
      // 3) Brand-new user. Google verified the email, so go straight to active.
      userId = ulid();
      await c.env.DB.prepare(
        `INSERT INTO user (id, email, display_name, status, email_verified, staff, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, 0, ?, ?)`,
      )
        .bind(userId, email, displayName, now, now)
        .run();
      await c.env.DB.prepare(
        `INSERT INTO credential (id, user_id, kind, oauth_provider, oauth_subject, created_at, updated_at)
         VALUES (?, ?, 'google_oauth', 'google', ?, ?, ?)`,
      )
        .bind(ulid(), userId, sub, now, now)
        .run();
      await logAudit(c.env, {
        actorUserId: userId,
        subjectType: 'user',
        subjectId: userId,
        action: 'user.signup',
        metadata: { method: 'google_oauth' },
        ip,
      });
      auditAction = 'user.oauth_created';
    }
  }

  // ─── Establish the session ─────────────────────────────────────────────────
  const session = await createSession(c.env, {
    userId,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  // Clear the one-shot state cookie and set the session cookie. Multiple
  // Set-Cookie headers via c.header(..., { append: true }).
  c.header('Set-Cookie', clearStateCookie());
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt), { append: true });
  c.header('Cache-Control', 'no-store');

  if (auditAction !== 'session.login') {
    await logAudit(c.env, {
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      action: auditAction,
      metadata: { provider: 'google' },
      ip,
    });
  }
  await logAudit(c.env, {
    actorUserId: userId,
    subjectType: 'session',
    subjectId: userId,
    action: 'session.login',
    metadata: { method: 'google_oauth' },
    ip,
  });

  // Land where a normal login lands (`/`), honoring a signed `next` if present.
  return c.redirect(`${origin}${next ?? '/'}`, 302);
});
