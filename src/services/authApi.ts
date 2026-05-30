export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  staff: boolean;
  plan?:
    | 'free'
    | 'pro'
    | 'agency'
    | 'enterprise';
  planStatus?: 'active' | 'past_due' | 'canceled' | 'trialing';
}

export interface MeResponse {
  user: AuthedUser;
  usage: unknown;
}

export type ApiErrorCode =
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'email_unverified'
  | 'email_send_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'token_invalid'
  | 'token_expired'
  | 'internal'
  | 'network_error'
  | 'unknown';

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  /** Extra fields from the server's error payload (e.g. `email` on email_unverified). */
  extra: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = 'GET', body } = init;
  const headers: Record<string, string> = {
    'X-GB-Client': 'web',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  if (!res.ok) {
    let code: ApiErrorCode = 'unknown';
    let message = res.statusText || 'Request failed';
    let extra: Record<string, unknown> = {};
    if (isJson) {
      try {
        const data = await res.json();
        if (data && typeof data === 'object') {
          const { error, message: msg, ...rest } = data as Record<string, unknown>;
          if (typeof error === 'string') code = error as ApiErrorCode;
          if (typeof msg === 'string') message = msg;
          extra = rest;
        }
      } catch {
        // ignore
      }
    }
    throw new ApiError(code, message, res.status, extra);
  }

  if (isJson) {
    return (await res.json()) as T;
  }
  return undefined as T;
}

export interface SignupResponse {
  // True when the signup carried a valid invitation token and was auto-
  // activated; the server set a session cookie and `user` is populated.
  // False (default) means the user has to click the verification email.
  activated: boolean;
  user?: AuthedUser;
}

export function signup(input: {
  email: string;
  displayName: string;
  password: string;
  turnstileToken?: string;
  // Optional post-verify redirect path. Used by invitee signups so the user
  // lands on /orgs/accept instead of the tier picker.
  next?: string;
  // Raw invitation token from the email link. When present + valid, the
  // server skips email verification and logs the user in immediately.
  invitationToken?: string;
}): Promise<SignupResponse> {
  return request<SignupResponse>('/auth/signup', { method: 'POST', body: input });
}

export function login(input: { email: string; password: string }): Promise<{ user: AuthedUser }> {
  return request<{ user: AuthedUser }>('/auth/login', { method: 'POST', body: input });
}

export function requestMagicLink(input: { email: string }): Promise<void> {
  return request('/auth/magic-link/request', { method: 'POST', body: input });
}

export function requestPasswordReset(input: { email: string }): Promise<void> {
  return request('/auth/password-reset/request', { method: 'POST', body: input });
}

export function confirmPasswordReset(input: { token: string; password: string }): Promise<void> {
  return request('/auth/password-reset/confirm', { method: 'POST', body: input });
}

export function logout(): Promise<void> {
  return request('/auth/logout', { method: 'POST' });
}

export function logoutAll(): Promise<void> {
  return request('/auth/logout-all', { method: 'POST' });
}

export function me(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

export function updateProfile(input: { displayName?: string }): Promise<{ user: AuthedUser }> {
  return request<{ user: AuthedUser }>('/api/me', { method: 'PATCH', body: input });
}

export function changeEmail(input: { newEmail: string }): Promise<void> {
  return request('/api/me/change-email', { method: 'POST', body: input });
}

export function confirmChangeEmail(input: { token: string }): Promise<void> {
  return request('/api/me/change-email/confirm', { method: 'POST', body: input });
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return request('/api/me/change-password', { method: 'POST', body: input });
}

export function deleteAccount(input: { password?: string }): Promise<void> {
  return request('/api/me', { method: 'DELETE', body: input });
}

export function resendVerification(input: { email: string }): Promise<void> {
  return request('/auth/verify-resend', { method: 'POST', body: input });
}
