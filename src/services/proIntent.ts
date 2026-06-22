// Pro-intent instrumentation + in-app upgrade-nudge gating.
//
// When a logged-in FREE user reaches a Pro-gated moment of value (exports a
// feed, hits the saved-feed cap, opens the rider-site / embed gate) we do two
// things: (1) show a one-time, dismissible nudge toward /pricing, and (2) fire
// a best-effort, first-party POST recording the intent so the warm-cohort
// export can rank "who tried to do a paid thing" (the hottest signal).
//
// No third-party JS or cookies: the only client storage is first-party
// localStorage (once-per-trigger dedupe). The POST is same-origin and
// session-authenticated. Mirrors the silent, keepalive style of
// services/trackBeacon.ts. We deliberately do NOT also write to the anonymous
// event store for these — pro-intent is a per-account, authenticated signal,
// separate from the cookieless analytics beacon.

import type { Plan } from './billingApi';

// The three contextual nudges. Each maps 1:1 to a UI moment and is the value
// sent as `action` to the pro-intent endpoint.
export type ProIntentAction = 'publish_intent' | 'feed_cap' | 'mini_site';

// localStorage key prefix; one key per action so each trigger fires once.
const NUDGE_KEY_PREFIX = 'gb_pro_nudge_';

export function nudgeStorageKey(action: ProIntentAction): string {
  return `${NUDGE_KEY_PREFIX}${action}`;
}

// Approved nudge copy (kept verbatim from the handoff). The em dash in
// `publish_intent` is intentional and signed off; do not "AI-de-dash" it.
export const PRO_NUDGE_COPY: Record<
  ProIntentAction,
  { message: string; cta: string; feature: string }
> = {
  publish_intent: {
    message:
      'Want this feed to live at a stable, auto-updating URL — and show up in Google/Apple/Transit? Get these features by upgrading to Pro.',
    cta: 'See Pro',
    feature: 'managed_publishing',
  },
  feed_cap: {
    message: 'Free saves 3 feeds. Pro saves unlimited and hosts them.',
    cta: 'Upgrade',
    feature: 'managed_publishing',
  },
  mini_site: {
    message: 'The embeddable rider site is a Pro feature.',
    cta: 'See Pro',
    feature: 'embeds',
  },
};

// A logged-in user with no paid plan. `plan` is optional on the user record;
// treat missing or 'free' as free. Anyone on pro/agency/enterprise is excluded.
export function isFreePlan(plan: Plan | null | undefined): boolean {
  return plan == null || plan === 'free';
}

export function hasNudgeFired(action: ProIntentAction): boolean {
  try {
    return localStorage.getItem(nudgeStorageKey(action)) !== null;
  } catch {
    // localStorage blocked (private mode, etc.) — treat as "not fired" so the
    // nudge can still show. It may re-show in that degraded case; acceptable.
    return false;
  }
}

export function markNudgeFired(action: ProIntentAction): void {
  try {
    localStorage.setItem(nudgeStorageKey(action), String(Date.now()));
  } catch {
    // ignore — see hasNudgeFired.
  }
}

// Eligibility for a nudge: logged-in, on the free plan, and not already fired
// for this trigger. Pure (modulo the localStorage read) so it's easy to test.
export function nudgeEligible(opts: {
  loggedIn: boolean;
  plan: Plan | null | undefined;
  action: ProIntentAction;
}): boolean {
  return opts.loggedIn && isFreePlan(opts.plan) && !hasNudgeFired(opts.action);
}

// Whether the account-menu "Upgrade" entry should be shown: logged-in free
// users only (hidden for pro/agency/enterprise and for logged-out visitors).
export function shouldShowUpgradeEntry(
  loggedIn: boolean,
  plan: Plan | null | undefined,
): boolean {
  return loggedIn && isFreePlan(plan);
}

// Fire-and-forget POST to the authenticated pro-intent endpoint. Matches the
// Part-A contract exactly: POST /api/me/pro-intent, header X-GB-Client: web,
// JSON body { action, source? }. `keepalive` so it survives a navigation or
// page unload; credentials included because the endpoint is session-
// authenticated. Silent on every failure — instrumentation must never disrupt
// the user.
export function recordProIntent(action: ProIntentAction, source?: string): void {
  try {
    void fetch('/api/me/pro-intent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GB-Client': 'web',
      },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify(source ? { action, source } : { action }),
    }).catch(() => {
      // Network errors are expected (offline, blocker) — silent.
    });
  } catch {
    // Defensive: never let a tracking error surface to the user.
  }
}

// The single "fire a nudge" entry point used by the UI. If the viewer is an
// eligible logged-in free user who hasn't seen this trigger yet, mark it shown
// (once-per-trigger) and record the pro-intent signal, then return true so the
// caller can reveal the visible nudge (e.g. a toast). Otherwise return false —
// a no-op, no POST, no storage write. Inline gates (the feed-cap banner, the
// embed paywall) still render for free users regardless of the return value;
// they only use this for the once-per-trigger POST. Toast-style nudges show
// only when this returns true.
export function fireProNudge(opts: {
  loggedIn: boolean;
  plan: Plan | null | undefined;
  action: ProIntentAction;
  source?: string;
}): boolean {
  if (!nudgeEligible(opts)) return false;
  markNudgeFired(opts.action);
  recordProIntent(opts.action, opts.source);
  return true;
}
