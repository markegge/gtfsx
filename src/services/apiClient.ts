// Shared low-level HTTP client for the SPA's API modules (auth, billing,
// orgs, admin, alerts, distribution, forum, projects). Centralizes the
// fetch/headers/JSON-parsing/ApiError-mapping boilerplate that was
// previously duplicated (near-identically) across all 8 service modules.
//
// The modules differed in what lands in `ApiError.extra` on a non-2xx JSON
// response:
//   - authApi/billingApi/orgsApi/adminApi ("rest" mode, see `restParseError`):
//     extra = the payload minus its `error`/`message` keys.
//   - alertsApi/distributionApi/forumApi ("full" mode, the default):
//     extra = the entire parsed payload, including `error`/`message`.
//   - projectsApi: its own bespoke error mapper (ConflictError on a 409 with
//     `currentVersion`) — kept local to that module rather than centralized
//     here, since it isn't shared by anything else.
// `apiRequest` takes an optional `parseError` override so each module's
// original error-shape is preserved exactly rather than flattened.

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

/** Headers sent on every request. */
export const DEFAULT_HEADERS = { 'X-GB-Client': 'web' };

export interface ApiRequestInit {
  method?: string;
  body?: unknown;
}

/**
 * Default error mapper: `extra` is the entire parsed JSON error payload,
 * including its `error`/`message` keys. Matches the original
 * alertsApi/distributionApi/forumApi behavior.
 */
export async function defaultParseError(res: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'unknown';
  let message = res.statusText || 'Request failed';
  let extra: Record<string, unknown> = {};
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const data = await res.json();
      if (data && typeof data === 'object') {
        const rec = data as Record<string, unknown>;
        if (typeof rec.error === 'string') code = rec.error as ApiErrorCode;
        if (typeof rec.message === 'string') message = rec.message as string;
        extra = rec;
      }
    } catch {
      // ignore
    }
  }
  return new ApiError(code, message, res.status, extra);
}

/**
 * Error mapper matching the original authApi/billingApi/orgsApi/adminApi
 * behavior: `extra` is the payload with the `error`/`message` keys stripped
 * out (so it only carries the "extra" fields, e.g. `email`).
 */
export async function restParseError(res: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'unknown';
  let message = res.statusText || 'Request failed';
  let extra: Record<string, unknown> = {};
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
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
  return new ApiError(code, message, res.status, extra);
}

/**
 * Shared fetch wrapper: JSON body, credentials included, ApiError on
 * non-2xx (via `parseError`, defaulting to `defaultParseError`), undefined
 * for 204/non-JSON success bodies.
 */
export async function apiRequest<T = unknown>(
  path: string,
  init: ApiRequestInit = {},
  opts: { parseError?: (res: Response) => Promise<ApiError> } = {},
): Promise<T> {
  const { method = 'GET', body } = init;
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
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

  if (!res.ok) {
    const parseError = opts.parseError ?? defaultParseError;
    throw await parseError(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return undefined as T;
}
