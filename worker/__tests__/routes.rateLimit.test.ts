// Rate limiting: repeated login attempts from the same simulated IP hit 429
// before the loop's upper bound (limits were doubled from the initial spec
// — per-IP 20/10min, per-email 10/10min).

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('rate limiting', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it(
    'repeated logins from the same CF-Connecting-IP within the window → 429',
    async () => {
      // Per-email is currently 10/10min, per-IP is 20/10min — the per-email
      // counter trips first when all attempts target one email. Loop past
      // both limits and assert the first 429 arrives before the end.
      const user = await seedUser({ email: 'rate-limit@example.com' });
      const client = makeClient();
      const attackerIp = '203.0.113.7';

      let first429: number | null = null;
      for (let i = 0; i < 22; i += 1) {
        const res = await client.post(
          '/auth/login',
          { email: user.email, password: 'wrong-password' },
          { headers: { 'CF-Connecting-IP': attackerIp } },
        );
        if (res.status === 429) {
          first429 = i;
          break;
        }
      }
      expect(first429).not.toBeNull();
      expect(first429).toBeLessThan(22);
    },
    30000,
  );

  it(
    "a different IP can still reach the endpoint after the first IP's counter is burned",
    async () => {
      const userA = await seedUser({ email: 'ip-a@example.com' });
      const userB = await seedUser({ email: 'ip-b@example.com' });
      const client = makeClient();

      // Burn the IP+email limit on one IP using userA (11 > per-email 10/10min).
      for (let i = 0; i < 11; i += 1) {
        await client.post(
          '/auth/login',
          { email: userA.email, password: 'wrong-password' },
          { headers: { 'CF-Connecting-IP': '198.51.100.1' } },
        );
      }

      // A request from a different IP for a different user should be fine
      // (wrong password → 401).
      const other = await client.post(
        '/auth/login',
        { email: userB.email, password: 'wrong-password' },
        { headers: { 'CF-Connecting-IP': '198.51.100.2' } },
      );
      expect(other.status).toBe(401);
    },
    20000,
  );
});
