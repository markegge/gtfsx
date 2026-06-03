// Client-side mirror of worker/billing/plans.ts. Kept in lockstep manually —
// these two files are the catalog for /pricing and the paywall overlays.

import type { Plan } from '../../services/billingApi';

export type FeatureKey =
  | 'managed_publishing'
  | 'draft_links'
  | 'mobility_db_submit'
  | 'embeds'
  | 'embed_remove_badge'
  | 'snapshot_history'
  | 'analysis_basic'
  | 'analysis_title_vi'
  | 'analysis_propensity'
  | 'org_workspace'
  | 'cross_org_member'
  | 'org_logo'
  | 'brand_color'
  | 'service_alerts'
  | 'phone_support';

// Pricing v3 (Jun 2026): demand dots are free for all; cost/coverage split into a
// free system-level summary + a paywalled route-level breakdown (analysis_basic
// stays Agency+); embeds stay Pro+ but only Agency+ removes the badge
// (embed_remove_badge); phone_support → Agency+. See worker/billing/plans.ts.
export const FEATURE_PLANS: Record<FeatureKey, readonly Plan[]> = {
  managed_publishing:  ['pro', 'agency', 'enterprise'],
  draft_links:         ['pro', 'agency', 'enterprise'],
  mobility_db_submit:  ['pro', 'agency', 'enterprise'],
  embeds:              ['pro', 'agency', 'enterprise'],
  embed_remove_badge:  ['agency', 'enterprise'],
  snapshot_history:    ['pro', 'agency', 'enterprise'],
  analysis_basic:      ['agency', 'enterprise'],
  analysis_title_vi:   ['agency', 'enterprise'],
  analysis_propensity: ['free', 'pro', 'agency', 'enterprise'],
  org_workspace:       ['agency', 'enterprise'],
  cross_org_member:    ['agency', 'enterprise'],
  org_logo:            ['agency', 'enterprise'],
  brand_color:         ['pro', 'agency', 'enterprise'],
  service_alerts:      ['agency', 'enterprise'],
  phone_support:       ['agency', 'enterprise'],
};

const PLAN_ORDER: Plan[] = ['free', 'pro', 'agency', 'enterprise'];

export function planHasFeature(plan: Plan | undefined | null, feature: FeatureKey): boolean {
  if (!plan) return false;
  return FEATURE_PLANS[feature].includes(plan);
}

export function cheapestPlanFor(feature: FeatureKey): Plan {
  for (const plan of PLAN_ORDER) {
    if (planHasFeature(plan, feature)) return plan;
  }
  return 'enterprise';
}

export function planDisplayName(plan: Plan): string {
  switch (plan) {
    case 'free': return 'Free';
    case 'pro': return 'Pro';
    // Internal id is 'agency' (DB column, code paths); the Stripe env-var names
    // (STRIPE_PRICE_TEAM_*) and product id stay 'team' for stability. 'Agency'
    // is the May-2026 display rename. See docs/REQUIREMENTS.md.
    case 'agency': return 'Agency';
    case 'enterprise': return 'Enterprise';
  }
}

// Description shown in paywall overlays, keyed by feature. Kept short and
// user-facing — never reference "the plan key" or internal terminology.
export const FEATURE_COPY: Record<FeatureKey, { title: string; description: string }> = {
  managed_publishing: {
    title: 'Publish to a stable URL',
    description: 'Turn your feed into a public URL that riders, regulators, and the Mobility Database can rely on.',
  },
  draft_links: {
    title: 'Share a draft preview link',
    description: 'Send stakeholders a link to a working feed before you publish.',
  },
  mobility_db_submit: {
    title: 'Submit to the Mobility Database',
    description: 'Get your feed listed in the canonical open transit catalog with one click.',
  },
  embeds: {
    title: 'Rider-facing embeds and mini-site',
    description: 'Drop schedules, route maps, and stop times into any website with copy-paste embed snippets.',
  },
  embed_remove_badge: {
    title: 'Remove the GTFS·X badge',
    description: 'Serve your embeds and mini-site white-label — without the “Powered by GTFS·X” badge.',
  },
  snapshot_history: {
    title: 'Named snapshots',
    description: 'Keep a history of named snapshots and restore any prior state with one click.',
  },
  analysis_basic: {
    title: 'Route-level coverage and cost analysis',
    description: 'System-level summaries are free. Unlock the per-route breakdown — coverage and operating cost route by route — with the Agency planning suite.',
  },
  analysis_title_vi: {
    title: 'Title VI equity analysis',
    description: 'Generate FTA-aligned reports comparing service levels across minority and low-income populations.',
  },
  analysis_propensity: {
    title: 'Ridership propensity heatmap',
    description: 'Layer ride-likelihood density onto your map to prioritize service investments.',
  },
  org_workspace: {
    title: 'Team workspace',
    description: 'Invite teammates to collaborate on feeds inside a shared organization.',
  },
  cross_org_member: {
    title: 'Cross-org membership',
    description: 'Built for consultants — work in multiple client orgs from one Agency subscription, without the client orgs paying for your seat.',
  },
  org_logo: {
    title: 'Custom organization logo',
    description: 'Upload your agency logo to brand published feeds and embed pages.',
  },
  brand_color: {
    title: 'Custom brand color',
    description: 'Match the published feed and embed pages to your agency’s brand color.',
  },
  service_alerts: {
    title: 'Service Alerts authoring',
    description: 'Publish GTFS-Realtime Service Alerts — detours, delays, and stop closures — to a live feed Google, Apple, and transit apps consume, without republishing your schedule.',
  },
  phone_support: {
    title: 'Phone support with SLA',
    description: 'Direct phone line + 24-hour response SLA, available on Agency and Enterprise plans.',
  },
};
