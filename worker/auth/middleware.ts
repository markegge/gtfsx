import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../env';
import { readSessionCookie, resolveSession } from './session';
import { unauthenticated, forbidden, validationFailed } from '../util/errors';

// Reads the session cookie (if any) and populates c.var.user / c.var.session.
// Does NOT reject if absent — that's requireAuth's job.
export const sessionMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = readSessionCookie(c.req.raw);
  if (token) {
    const resolved = await resolveSession(c.env, token);
    if (resolved) {
      c.set('user', resolved.user);
      c.set('session', { id: resolved.sessionId, userId: resolved.user.id });
    }
  }
  await next();
};

// Require an authenticated, active user.
export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.var.user;
  if (!user) throw unauthenticated();
  if (user.status === 'disabled' || user.status === 'deleted_soft') throw forbidden('Account unavailable');
  // Email-unverified users can reach /api/me and /auth/verify-resend but nothing else.
  const path = new URL(c.req.url).pathname;
  if (user.status === 'pending_verification' && !path.startsWith('/api/me') && !path.startsWith('/auth/verify')) {
    throw forbidden('Please verify your email address first');
  }
  await next();
};

// CSRF defense for cookie-auth APIs: require a custom header that forms
// can't set cross-origin. Combined with SameSite=Lax this blocks CSRF.
// Applied to all /api/* and /auth/* POST/PUT/PATCH/DELETE routes.
export const requireClientHeader: MiddlewareHandler<AppContext> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  const header = c.req.header('X-GB-Client');
  if (header !== 'web') {
    throw validationFailed('Missing client header');
  }
  await next();
};
