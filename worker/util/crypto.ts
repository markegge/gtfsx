// Crypto primitives backed by Web Crypto (native in Cloudflare Workers).
// No external dependencies.

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    s += BASE64URL_ALPHABET[b0 >> 2];
    s += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    s += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    s += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return s;
}

export function base64urlDecode(s: string): Uint8Array {
  // Tolerate both base64 and base64url; padding optional.
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Random 256-bit token, base64url-encoded (43 chars, no padding). */
export function generateToken(): string {
  return base64url(randomBytes(32));
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// ─── Password hashing (PBKDF2-HMAC-SHA256) ────────────────────────────────────
//
// Native Web Crypto. Format: `pbkdf2$<iterations>$<salt_b64url>$<hash_b64url>`.
//
// The iteration count is capped by workerd (Cloudflare Workers' runtime) at
// 100,000. Above that, `crypto.subtle.deriveBits` throws NotSupportedError
// in production — even though miniflare (local dev + tests) accepts higher
// values. 100,000 matches NIST SP 800-63B's minimum for PBKDF2-SHA256 and is
// below OWASP's recommended 600,000; revisit if we can swap in a WASM argon2id
// bundle or if workerd lifts the cap. `verifyPassword` reads the iteration
// count from the stored hash, so we can migrate hashes forward in place.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BITS = 256;
const PBKDF2_SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  if (!Number.isFinite(iter) || iter < 1) return false;
  const salt = base64urlDecode(parts[2]);
  const expected = base64urlDecode(parts[3]);
  const actual = await pbkdf2(password, salt, iter);
  return constantTimeEqual(expected, actual);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_HASH_BITS,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
