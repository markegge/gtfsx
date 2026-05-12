// Client-side mirror of worker/billing/plans.ts. Kept in lockstep manually —
// these two files are the catalog for /pricing and the paywall overlays.

import type { Plan } from '../../services/billingApi';

export type FeatureKey =
  | 'managed_publishing'
  | 'draft_links'
  | 'mobility_db_submit'
  | 'embeds'
  | 'analysis_basic'
  | 'analysis_title_vi'
  | 'analysis_propensity'
  | 'org_workspace'
  | 'cross_org_member'
  | 'org_logo'
  | 'brand_color'
  | 'phone_support';

export const FEATURE_PLANS: Record<FeatureKey, readonly Plan[]> = {
  managed_publishing:  ['pro', 'team', 'consultant', 'consultant_firm', 'enterprise'],
  draft_links:         ['pro', 'team', 'consultant', 'consultant_firm', 'enterprise'],
  mobility_db_submit:  ['pro', 'team', 'consultant', 'consultant_firm', 'enterprise'],
  embeds:              ['pro', 'team', 'consultant', 'consultant_firm', 'enterprise'],
  analysis_basic:      ['pro', 'team', 'consultant', 'consultant_firm', 'enterprise'],
  analysis_title_vi:   ['team', 'consultant', 'consultant_firm', 'enterprise'],
  analysis_propensity: ['team', 'consultant', 'consultant_firm', 'enterprise'],
  org_workspace:       ['team', 'consultant', 'consultant_firm', 'enterprise'],
  cross_org_member:    ['consultant', 'consultant_firm', 'enterprise'],
  org_logo:            ['team', 'consultant', 'consultant_firm', 'enterprise'],
  brand_color:         ['pro', 'team', 'consultant', 'consultant_firm', 'enterprise'],
  phone_support:       ['enterprise'],
};

const PLAN_ORDER: Plan[] = ['free', 'pro', 'team', 'consultant', 'consultant_firm', 'enterprise'];

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
    case 'team': return 'Team';
    case 'consultant': return 'Consultant';
    case 'consultant_firm': return 'Consultant Firm';
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
  analysis_basic: {
    title: 'Demographic coverage and cost estimation',
    description: 'Visualize who your service reaches and estimate the operating cost of a proposed schedule.',
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
    description: 'Built for consultants — work in multiple client orgs without the orgs paying for your seat.',
  },
  org_logo: {
    title: 'Custom organization logo',
    description: 'Upload your agency logo to brand published feeds and embed pages.',
  },
  brand_color: {
    title: 'Custom brand color',
    description: 'Match the published feed and embed pages to your agency’s brand color.',
  },
  phone_support: {
    title: 'Phone support with SLA',
    description: 'Direct phone line + 24-hour response SLA, available on Enterprise plans.',
  },
};
