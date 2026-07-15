// Owner-inbox alert when someone subscribes to a paid plan (Planner),
// fired best-effort from the checkout webhook.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../env';
import { sendUpgradeNotification } from '../email';
import { setupEmailCapture, type EmailCapture } from './_setup';

describe('sendUpgradeNotification', () => {
  let capture: EmailCapture;
  beforeEach(() => {
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('emails the owner inbox with plan + customer for a Planner subscription', async () => {
    await sendUpgradeNotification(env as unknown as Env, {
      plan: 'agency',
      ownerType: 'org',
      email: 'newcustomer@transit.gov',
      amountTotal: 298800,
    });
    expect(capture.emails).toHaveLength(1);
    const m = capture.emails[0];
    expect(m.to).toBe('owner@example.com');
    expect(m.subject).toContain('Planner');
    expect(m.subject).toContain('newcustomer@transit.gov');
    expect(m.text).toContain('$2988.00');
    expect(m.text).toContain('organization');
  });

  it('handles a missing checkout total gracefully', async () => {
    await sendUpgradeNotification(env as unknown as Env, {
      plan: 'agency',
      ownerType: 'org',
      email: 'p@example.com',
      amountTotal: null,
    });
    expect(capture.emails[0].subject).toContain('Planner');
    expect(capture.emails[0].text).toContain('—');
  });

  it('is a no-op when OWNER_NOTIFY_EMAIL is not configured', async () => {
    const noOwnerEnv = { ...env, OWNER_NOTIFY_EMAIL: undefined } as unknown as Env;
    await sendUpgradeNotification(noOwnerEnv, {
      plan: 'agency',
      ownerType: 'org',
      email: 'p@example.com',
      amountTotal: 298800,
    });
    expect(capture.emails).toHaveLength(0);
  });
});
