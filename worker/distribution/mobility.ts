// Shared MobilityData access-token exchange. Used by both:
//   - worker/legacy/imports.ts (the catalog search proxy on /_import/search)
//   - worker/projects/routes.ts (outbound feed submissions on publish)
// The refresh token is long-lived but the access token rotates; we cache the
// latter in-module so concurrent requests share a single round-trip.

import type { Env } from '../env';

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getMobilityDbAccessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const r = await fetch('https://api.mobilitydatabase.org/v1/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: env.MOBILITY_DATABASE_REFRESH_TOKEN }),
  });
  if (!r.ok) {
    throw new Error(`Mobility DB token exchange failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    value: j.access_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

// Exposed for tests — lets a test-side reset force fresh token exchange after
// mocks are installed. Not exported from any index; used via direct import.
export function __resetMobilityDbTokenCache(): void {
  cachedToken = null;
}
