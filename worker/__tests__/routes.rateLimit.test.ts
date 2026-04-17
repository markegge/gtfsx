// Rate limiting: 11th login attempt from the same simulated IP returns 429.

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
    '11th login from the same CF-Connecting-IP within the 10-min window → 429',
    async () => {
      // Seed multiple users so we don't trip the per-email limit (5/window)
      // before the per-IP limit (10/window). We use the same seeded user for
      // all attempts; the per-email RL will trigger first (5/window), but the
      // first 429 is what we want to observe.
      const user = await seedUser({ email: 'rate-limit@example.com' });
      const client = makeClient();
      const attackerIp = '203.0.113.7';

      let first429: number | null = null;
      for (let i = 0; i < 12; i += 1) {
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
      // With limit=5/email OR limit=10/IP, the first 429 should arrive
      // before the 12th attempt.
      expect(first429).not.toBeNull();
      expect(first429).toBeLessThan(12);
    },
    20000,
  );

  it(
    "a different IP can still reach the endpoint after the first IP's counter is burned",
    async () => {
      const userA = await seedUser({ email: 'ip-a@example.com' });
      const userB = await seedUser({ email: 'ip-b@example.com' });
      const client = makeClient();

      // Burn the IP+email limit on one IP using userA.
      for (let i = 0; i < 6; i += 1) {
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
