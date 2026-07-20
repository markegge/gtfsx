/**
 * Unit tests for the shared client-side trial model (orgTrial.ts): the "is this
 * org on a live trial?" predicate + days-left, the auto-created-workspace
 * naming/slug, and the click-time resolution of which org hosts a new trial
 * (zero-org auto-create vs single-org one-click vs multi-org picker).
 */
import { describe, expect, it } from 'vitest';
import type { OrgSummary } from '../../../services/orgsApi';
import {
  canHostTrial,
  deriveTrialOrgName,
  isOrgOnTrial,
  orgsOnTrial,
  resolveTrialStart,
  slugifyOrgName,
  trialDaysLeft,
  trialWorkspaceSlug,
} from '../orgTrial';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function org(over: Partial<OrgSummary>): OrgSummary {
  return {
    id: over.id ?? 'org1',
    slug: over.slug ?? 'org-1',
    name: over.name ?? 'Org One',
    role: over.role ?? 'owner',
    plan: over.plan,
    planStatus: over.planStatus,
    planExpiresAt: over.planExpiresAt ?? null,
    trialEndsAt: over.trialEndsAt ?? null,
    memberCount: over.memberCount ?? 1,
    projectCount: over.projectCount ?? 0,
    createdAt: over.createdAt ?? NOW,
  };
}

describe('isOrgOnTrial', () => {
  it('true for an agency org with future trial markers', () => {
    expect(isOrgOnTrial(org({ plan: 'agency', trialEndsAt: NOW + 5 * DAY, planExpiresAt: NOW + 5 * DAY }), NOW)).toBe(true);
  });
  it('false when not on the agency plan', () => {
    expect(isOrgOnTrial(org({ plan: 'free', trialEndsAt: NOW + 5 * DAY, planExpiresAt: NOW + 5 * DAY }), NOW)).toBe(false);
  });
  it('false for a comp grant (trialEndsAt null)', () => {
    expect(isOrgOnTrial(org({ plan: 'agency', trialEndsAt: null, planExpiresAt: NOW + 5 * DAY }), NOW)).toBe(false);
  });
  it('false after a paid conversion (planExpiresAt cleared)', () => {
    expect(isOrgOnTrial(org({ plan: 'agency', trialEndsAt: NOW + 5 * DAY, planExpiresAt: null }), NOW)).toBe(false);
  });
  it('false once the trial end has passed', () => {
    expect(isOrgOnTrial(org({ plan: 'agency', trialEndsAt: NOW - 1, planExpiresAt: NOW - 1 }), NOW)).toBe(false);
  });
});

describe('trialDaysLeft', () => {
  it('rounds partial days up', () => {
    expect(trialDaysLeft(NOW + 5 * DAY - 1000, NOW)).toBe(5);
    expect(trialDaysLeft(NOW + 13 * DAY + 1000, NOW)).toBe(14);
  });
  it('never drops below 1 while still live', () => {
    expect(trialDaysLeft(NOW + 1000, NOW)).toBe(1);
  });
});

describe('orgsOnTrial', () => {
  it('keeps only orgs on a live trial', () => {
    const list = [
      org({ id: 'a', plan: 'agency', trialEndsAt: NOW + 2 * DAY, planExpiresAt: NOW + 2 * DAY }),
      org({ id: 'b', plan: 'free' }),
      org({ id: 'c', plan: 'agency', trialEndsAt: null, planExpiresAt: null }), // paid/comp
    ];
    expect(orgsOnTrial(list, NOW).map((o) => o.id)).toEqual(['a']);
  });
});

describe('canHostTrial', () => {
  it('true for free / unset plan, false for paid tiers', () => {
    expect(canHostTrial({ plan: 'free' })).toBe(true);
    expect(canHostTrial({ plan: undefined })).toBe(true);
    expect(canHostTrial({ plan: 'agency' })).toBe(false);
    expect(canHostTrial({ plan: 'enterprise' })).toBe(false);
  });
});

describe('slugifyOrgName', () => {
  it('lowercases, dashes, and trims', () => {
    expect(slugifyOrgName("Mark E Test's Workspace")).toBe('mark-e-test-s-workspace');
  });
  it('falls back when the result is too short', () => {
    expect(slugifyOrgName('!!')).toBe('team-org');
  });
});

describe('trialWorkspaceSlug', () => {
  it('returns the clean slug on the first attempt', () => {
    expect(trialWorkspaceSlug('missoula-transit-workspace', 0)).toBe('missoula-transit-workspace');
  });
  it('appends a short suffix on retry (collision fallback)', () => {
    const s = trialWorkspaceSlug('taken-slug', 1);
    expect(s).toMatch(/^taken-slug-[a-z0-9]{1,4}$/);
    expect(s).not.toBe('taken-slug');
  });
});

describe('deriveTrialOrgName', () => {
  it('uses the display name when present', () => {
    expect(deriveTrialOrgName({ displayName: 'Missoula Transit', email: 'x@y.com' })).toBe("Missoula Transit's Workspace");
  });
  it('falls back to the email local part when no display name', () => {
    expect(deriveTrialOrgName({ displayName: '', email: 'mark+test33@eateggs.com' })).toBe("mark+test33's Workspace");
    expect(deriveTrialOrgName({ displayName: null, email: 'jo@x.com' })).toBe("jo's Workspace");
  });
});

describe('resolveTrialStart', () => {
  it('uses a pinned free org', () => {
    const pinned = org({ id: 'pin', plan: 'free' });
    expect(resolveTrialStart(pinned, [])).toEqual({ kind: 'use', org: pinned });
  });
  it('blocks a pinned org that already has a plan', () => {
    expect(resolveTrialStart(org({ id: 'pin', plan: 'agency' }), [])).toEqual({ kind: 'blocked' });
  });
  it('auto-creates when the user has no eligible org', () => {
    expect(resolveTrialStart(null, [])).toEqual({ kind: 'create' });
  });
  it('uses the single eligible org (one click)', () => {
    const only = org({ id: 'solo', plan: 'free' });
    expect(resolveTrialStart(null, [only])).toEqual({ kind: 'use', org: only });
  });
  it('asks which org when several qualify', () => {
    const a = org({ id: 'a', plan: 'free' });
    const b = org({ id: 'b', plan: 'free' });
    expect(resolveTrialStart(null, [a, b])).toEqual({ kind: 'pick', orgs: [a, b] });
  });
});
