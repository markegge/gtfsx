// Test-side HTTP client that talks to the Worker through SELF. Maintains a
// single cookie across requests, injects the required X-GB-Client header, and
// returns typed JSON for convenience.

import { SELF } from 'cloudflare:test';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: Record<string, unknown>) {
    super(`${status} ${code}: ${message}`);
  }
}

export interface RawResponseOpts {
  body?: BodyInit | null;
  headers?: Record<string, string>;
  method?: string;
  /** If set, don't send the existing cookie. */
  noCookie?: boolean;
  /** If true, don't auto-set X-GB-Client — for CSRF tests. */
  noClientHeader?: boolean;
  /** Don't follow 3xx redirects — fetch already returns them as-is; this just documents intent. */
  redirect?: 'follow' | 'manual';
}

export interface TestClient {
  get(path: string, opts?: RawResponseOpts): Promise<Response>;
  post(path: string, body?: unknown, opts?: RawResponseOpts): Promise<Response>;
  put(path: string, body?: unknown, opts?: RawResponseOpts): Promise<Response>;
  patch(path: string, body?: unknown, opts?: RawResponseOpts): Promise<Response>;
  delete(path: string, body?: unknown, opts?: RawResponseOpts): Promise<Response>;
  /** Escape hatch — pass a fully-built Request. Cookie is not auto-applied. */
  raw(req: Request): Promise<Response>;
  /** Parse a Response as JSON; throws ApiError on non-2xx. */
  json<T = unknown>(res: Response): Promise<T>;
  /** Current cookie header value (or null). */
  readonly cookie: string | null;
  /** Forcibly set/clear the cookie — used in tests that want to mutate or share sessions. */
  setCookie(value: string | null): void;
}

const BASE = 'http://127.0.0.1';

function parseSetCookie(header: string | null): string | null {
  if (!header) return null;
  // The Set-Cookie header in Fetch can contain multiple cookies separated by
  // commas, but the session cookie is the only one we set and its value is
  // URL-safe base64 with no commas, so taking up to the first semicolon is fine.
  const head = header.split(';')[0];
  return head || null;
}

export function makeClient(): TestClient {
  let cookie: string | null = null;

  async function req(path: string, method: string, body: unknown, opts: RawResponseOpts = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (!opts.noClientHeader) headers['X-GB-Client'] = 'web';
    if (!opts.noCookie && cookie) headers['Cookie'] = cookie;
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k] = v;

    let bodyInit: BodyInit | null | undefined = opts.body ?? null;
    if (body !== undefined && body !== null && opts.body === undefined) {
      if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        bodyInit = body as BodyInit;
      } else if (typeof body === 'string') {
        bodyInit = body;
      } else {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
        bodyInit = JSON.stringify(body);
      }
    }

    const url = new URL(path, BASE).toString();
    // Default to `redirect: 'manual'` so tests can assert on 302 responses.
    // Callers override via `opts` if they need auto-follow.
    const init: RequestInit = {
      method,
      headers,
      body: bodyInit,
      redirect: opts.redirect ?? 'manual',
    };
    const res = await SELF.fetch(url, init);

    const sc = parseSetCookie(res.headers.get('Set-Cookie'));
    if (sc) {
      // Preserve expired-cookie clears too (Max-Age=0 on logout). We still
      // store the new value — handlers that want to check the cleared state
      // can inspect `client.cookie`.
      cookie = sc;
    }
    return res;
  }

  return {
    get: (p, o) => req(p, 'GET', undefined, o),
    post: (p, b, o) => req(p, 'POST', b, o),
    put: (p, b, o) => req(p, 'PUT', b, o),
    patch: (p, b, o) => req(p, 'PATCH', b, o),
    delete: (p, b, o) => req(p, 'DELETE', b, o),
    async raw(r) {
      return SELF.fetch(r);
    },
    async json<T = unknown>(res: Response): Promise<T> {
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
      }
      if (res.status >= 200 && res.status < 300) return parsed as T;
      const p = (parsed ?? {}) as { error?: string; message?: string };
      throw new ApiError(res.status, p.error ?? 'unknown', p.message ?? res.statusText, (parsed as Record<string, unknown>) ?? {});
    },
    get cookie() {
      return cookie;
    },
    setCookie(v) {
      cookie = v;
    },
  };
}

// Convenience: extract a query parameter from a redirect Location.
export function locationQuery(res: Response, name: string): string | null {
  const loc = res.headers.get('Location');
  if (!loc) return null;
  try {
    const u = new URL(loc, BASE);
    return u.searchParams.get(name);
  } catch {
    return null;
  }
}

// Convenience: the pathname of a redirect.
export function locationPath(res: Response): string | null {
  const loc = res.headers.get('Location');
  if (!loc) return null;
  try {
    return new URL(loc, BASE).pathname;
  } catch {
    return null;
  }
}
