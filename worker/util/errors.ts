import { HTTPException } from 'hono/http-exception';

// Thin wrappers around Hono's HTTPException that give us consistent error
// bodies ({ error: code, message: ... }) and typed codes.

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'invalid_credentials'
  | 'email_unverified'
  | 'token_invalid'
  | 'token_expired'
  | 'internal';

export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500, code: ErrorCode, message: string, extra?: Record<string, unknown>) {
    super(status, {
      res: new Response(JSON.stringify({ error: code, message, ...extra }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
  }
}

export const unauthenticated = (msg = 'Sign in required') => new ApiError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (msg: string, extra?: Record<string, unknown>) => new ApiError(409, 'conflict', msg, extra);
export const validationFailed = (msg: string, extra?: Record<string, unknown>) => new ApiError(422, 'validation_failed', msg, extra);
export const rateLimited = (msg = 'Too many requests') => new ApiError(429, 'rate_limited', msg);
export const quotaExceeded = (msg: string, extra?: Record<string, unknown>) => new ApiError(409, 'quota_exceeded', msg, extra);
export const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
export const emailUnverified = () => new ApiError(403, 'email_unverified', 'Please verify your email address');
export const tokenInvalid = () => new ApiError(400, 'token_invalid', 'Invalid or unknown token');
export const tokenExpired = () => new ApiError(400, 'token_expired', 'This link has expired — please request a new one');
