import type { Env } from '../env';
import { rateLimited } from './errors';

// Tiny KV-backed rate limiter. Fixed window (per-key, per-interval).
// Not perfectly atomic — KV is eventually consistent — but close enough for
// auth endpoints. For higher-contention endpoints we'd move to Durable Objects.

export interface RateLimitOpts {
  key: string;          // 'auth:login:ip:1.2.3.4'
  limit: number;        // requests per window
  windowSec: number;    // window length in seconds
}

export async function rateLimit(env: Env, opts: RateLimitOpts): Promise<void> {
  const bucketId = Math.floor(Date.now() / 1000 / opts.windowSec);
  const bucketKey = `rl:${opts.key}:${bucketId}`;
  const current = await env.KV.get(bucketKey);
  const n = current ? parseInt(current, 10) : 0;
  if (n >= opts.limit) {
    throw rateLimited(`Too many requests — try again in ${opts.windowSec}s`);
  }
  // Best-effort increment. If two requests race, one may slip through; fine
  // for our threat model (we block well before the real abuse rate).
  await env.KV.put(bucketKey, String(n + 1), { expirationTtl: opts.windowSec + 10 });
}

export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}
