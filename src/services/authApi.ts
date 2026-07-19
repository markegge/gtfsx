import { apiRequest, restParseError, ApiError, type ApiErrorCode } from './apiClient';
// Re-exported so the ~25 existing component imports of `ApiError`/`ApiErrorCode`
// from './authApi' keep working; apiClient.ts is now the canonical source.
export { ApiError, type ApiErrorCode };

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  staff: boolean;
  plan?:
    | 'free'
    | 'agency'
    | 'enterprise';
  planStatus?: 'active' | 'past_due' | 'canceled' | 'trialing';
  /**
   * True once the user has consumed their one self-serve no-card trial.
   * Populated by GET /api/me; may be undefined on the login/signup response
   * (treat undefined as "not yet used" — the pricing page rehydrates via /me).
   */
  trialUsed?: boolean;
}

export interface MeResponse {
  user: AuthedUser;
  usage: unknown;
}

function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  return apiRequest<T>(path, init, { parseError: restParseError });
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
