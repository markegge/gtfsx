// Per-user, per-day message quota for "Ask GTFS·X", KV-backed (same eventual-
// consistency tradeoff as worker/util/rateLimit.ts — close enough; we block well
// before any real abuse rate, and the model spend is the thing we're capping).

import type { Env } from '../env';
import { ASSISTANT_DAILY_QUOTA } from './config';
import type { Plan } from '../projects/quotas';

export interface QuotaState {
  plan: Plan;
  limit: number;
  used: number;      // count BEFORE this request
  remaining: number; // limit - used, floored at 0
  resetAt: number;   // ms epoch of the next UTC day boundary
}

// UTC day bucket key. A user's quota resets at 00:00 UTC.
function dayKey(userId: string): { key: string; resetAt: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const resetAt = Date.UTC(y, now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return { key: `assistant:quota:${userId}:${y}-${m}-${d}`, resetAt };
}

// Read the current usage without incrementing. Used to decide whether to admit
// a request (throw a structured 429 in the route if remaining <= 0).
export async function readQuota(env: Env, userId: string, plan: Plan): Promise<QuotaState> {
  const { key, resetAt } = dayKey(userId);
  const raw = await env.KV.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  const limit = ASSISTANT_DAILY_QUOTA[plan] ?? ASSISTANT_DAILY_QUOTA.free;
  return { plan, limit, used, remaining: Math.max(0, limit - used), resetAt };
}

// Increment the day counter (best-effort; a race may let one extra request slip
// through, which is fine). Call once a request is admitted, before the model runs.
export async function consumeQuota(env: Env, userId: string): Promise<void> {
  const { key, resetAt } = dayKey(userId);
  const raw = await env.KV.get(key);
  const n = raw ? parseInt(raw, 10) || 0 : 0;
  // TTL a little past the reset boundary so stale buckets self-clean.
  const ttl = Math.max(60, Math.ceil((resetAt - Date.now()) / 1000) + 60);
  await env.KV.put(key, String(n + 1), { expirationTtl: ttl });
}
