/**
 * The multi-org gate (blockedFromAdditionalOrg): a user may own at most one org
 * unless they own an enterprise-plan org. Mirrors the server rule in
 * worker/billing/plans.ts — kept in parity.
 *
 * Drives the three UserMenu "+ Create organization" render states:
 *   - blocked (returns true)  → the create-org row is HIDDEN entirely (no upsell);
 *                               the server still enforces it (402 multi_org).
 *   - not blocked + eligible  → the create dialog opens.
 *   - not blocked + no Planner → the existing first-org Planner upsell.
 */
import { describe, expect, it } from 'vitest';
import { blockedFromAdditionalOrg } from '../planConfig';

describe('blockedFromAdditionalOrg', () => {
  it('never blocks the first org (empty list) — trial auto-create stays open', () => {
    expect(blockedFromAdditionalOrg([])).toBe(false);
  });

  it('blocks when the user already owns a non-enterprise org', () => {
    expect(blockedFromAdditionalOrg(['free'])).toBe(true);
    expect(blockedFromAdditionalOrg(['agency'])).toBe(true);
    expect(blockedFromAdditionalOrg(['agency', 'agency'])).toBe(true);
  });

  it('does not block when the user owns an enterprise org', () => {
    expect(blockedFromAdditionalOrg(['enterprise'])).toBe(false);
    expect(blockedFromAdditionalOrg(['agency', 'enterprise'])).toBe(false);
  });

  it('tolerates null/undefined plan values', () => {
    expect(blockedFromAdditionalOrg([null])).toBe(true);
    expect(blockedFromAdditionalOrg([undefined])).toBe(true);
    expect(blockedFromAdditionalOrg([null, 'enterprise'])).toBe(false);
  });
});
