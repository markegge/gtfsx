// Canonical pricing + checkout page. This single page replaces the old split
// between /pricing (marketing) and /upgrade (the tier-picker). It serves two
// audiences off one set of plan cards so they can never drift apart again:
//   - Logged-out visitors browsing plans → cards link to /signup (carrying the
//     chosen plan through verification so they land back here for checkout).
//   - Logged-in users upgrading → cards start Stripe Checkout (or the Agency
//     org-create sub-step) directly, with optional context from:
//       ?plan=&interval=   deep-link / post-verify auto-checkout
//       ?feature=<key>     paywall entry — highlights the cheapest unlocking plan
//       ?source=welcome    post-signup-verify landing
//       ?ownerType=org&ownerId=…  org-scoped Agency checkout (from org billing)
// Reachable from the post-verify redirect, account/org billing, paywall
// overlays, the nav, and the legacy /upgrade + /welcome/plan 301s.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { useStore } from '../../store';
import { billingEnabled } from '../../utils/featureFlags';
import {
  fetchPlanCatalog,
  openBillingPortal,
  startCheckout,
  type PlanCatalogEntry,
  type Plan,
} from '../../services/billingApi';
import { createOrg, roleAtLeast, type OrgSummary } from '../../services/orgsApi';
import { ApiError } from '../../services/authApi';
import { trackCtaClick } from '../../services/trackBeacon';
import { planDisplayName, cheapestPlanFor, FEATURE_COPY, type FeatureKey } from './planConfig';
import { annualToMonthlyEquivalent, annualSavings } from './pricingUtils';
import { TestModeBanner } from './TestModeBanner';
import { TalkToSalesModal } from './TalkToSalesModal';

// Fallback catalog used when the worker is unreachable (e.g. /pricing rendered
// before backend is enabled). Kept in sync with worker/billing/plans.ts.
const FALLBACK_PLANS: PlanCatalogEntry[] = [
  {
    plan: 'free',
    displayName: 'Free',
    monthlyPriceUsd: 0,
    annualPriceUsd: 0,
    perSeat: false,
    tagline: 'Create, edit, validate, and export GTFS feeds — in your browser.',
    features: [
      'Create and edit routes, stops, trips, and schedules on a live map',
      'Add GTFS-Flex zones and booking rules to any feed',
      'Validate against the GTFS spec as you work',
      'Import an existing feed or start from scratch — no signup required',
      'Export a spec-clean GTFS .zip and host it anywhere',
      'Up to 3 saved feeds in the cloud',
      'Nationwide demand-propensity map',
      'Community support',
    ],
  },
  {
    plan: 'pro',
    displayName: 'Pro',
    monthlyPriceUsd: 49,
    annualPriceUsd: 499,
    perSeat: false,
    tagline: 'Host and publish feeds.',
    features: [
      'Up to 10 saved feeds',
      'Publish 1 feed to a stable URL',
      'Rider-facing embeds + mini-site (with GTFS·X badge)',
      'Submit to the Mobility Database',
      'Named snapshot history',
      'Custom brand color',
      'Email support',
    ],
  },
  {
    plan: 'agency',
    displayName: 'Agency',
    monthlyPriceUsd: 299,
    annualPriceUsd: 2499,
    perSeat: false,
    tagline: 'Plan routes and service as a team.',
    features: [
      'Everything in Pro',
      'Unlimited feeds',
      'Route operating cost estimates',
      'Demographic coverage analysis',
      'Title VI equity analysis',
      'Scenario comparison',
      'Service Alerts authoring (GTFS-Realtime)',
      'Fully white-labeled rider site (your domain, your brand)',
      'Unlimited team members',
      'Cross-org membership for consultants',
      'Custom org logo',
      'Phone + email support',
    ],
    detailsHref: '/planning',
    detailsLabel: 'See all planning features →',
  },
  {
    plan: 'enterprise',
    displayName: 'Enterprise',
    monthlyPriceUsd: null,
    annualPriceUsd: null,
    perSeat: false,
    tagline: 'For state DOTs, RTAP networks, and large consortiums.',
    features: [
      'Custom feed and seat limits',
      'Unlimited Premium Feed Management',
      'Branded mini-sites',
      'Full Route Planning Features',
      'Phone + email support with SLA',
      'Contract terms via PO or invoice',
    ],
  },
];

const POPULAR_PLAN: Plan = 'agency';
const ENTERPRISE_MAIL =
  'mailto:hello@gtfsx.com?subject=GTFS·X Enterprise inquiry&body=Hi%20—%20I%27d%20like%20to%20learn%20more%20about%20the%20Enterprise%20plan.';

// Done-for-you services: primary CTA books a scoping call via Fantastical;
// email is the secondary path, using the same inquiry-driven mailto pattern
// as Enterprise (no contact-form backend). Distinct mail subjects let Mark
// route in his inbox; pre-filled bodies force the agency to scope before sending.
const SCHEDULE_CALL_URL = 'https://fantastical.app/markegge/gtfsx-feed-consult';

const FIX_FEED_MAIL =
  'mailto:hello@gtfsx.com?subject=GTFS%C2%B7X%20—%20Fix%20my%20feed&body=Hi%20Mark%20—%0A%0AAgency%20name%3A%20%0AAgency%20website%3A%20%0ACurrent%20feed%20URL%20(if%20any)%3A%20%0AWhat%27s%20broken%3A%20%0A';

const BUILD_FEED_MAIL =
  'mailto:hello@gtfsx.com?subject=GTFS%C2%B7X%20—%20Build%20a%20feed&body=Hi%20Mark%20—%0A%0AAgency%20name%3A%20%0AAgency%20website%3A%20%0ARoute%20count%3A%20%0AService%20type%20(fixed-route%2C%20Flex%2C%20both)%3A%20%0ASchedule%20source%20(spreadsheet%2C%20PDF%2C%20website)%3A%20%0A';

// Slugify an org name down to lowercase ASCII + dashes within the constraint
// the server enforces (3-63 chars, must start with letter/digit).
function slugifyOrgName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (cleaned.length >= 3) return cleaned;
  return (cleaned || 'team') + '-org';
}

export function PricingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const userOrgs = useStore((s) => s.userOrgs);
  const orgsLoaded = useStore((s) => s.orgsLoaded);
  const loadOrgs = useStore((s) => s.loadOrgs);
  const upsertUserOrg = useStore((s) => s.upsertUserOrg);

  // Context params carried over from the old /upgrade entry points.
  const source = searchParams.get('source'); // 'welcome' = post-signup verify
  const featureParam = searchParams.get('feature') as FeatureKey | null;
  const presetOwnerType = searchParams.get('ownerType') as 'user' | 'org' | null;
  const presetOwnerId = searchParams.get('ownerId');
  const directPlanParam = searchParams.get('plan');
  const directIntervalParam = searchParams.get('interval') as 'month' | 'year' | null;

  // When we arrive with explicit checkout intent (a paywall feature, the
  // post-verify welcome, an org-scoped upgrade, or a deep-linked plan) we show
  // a focused picker — just the cards + context header — instead of the full
  // marketing page (services / comparisons / FAQ).
  const checkoutContext = Boolean(
    featureParam || source === 'welcome' || presetOwnerType || directPlanParam,
  );

  // Each paid card has its own monthly/annual toggle so users can compare
  // (e.g. Pro monthly vs Agency annual) side-by-side. Keyed by plan id;
  // defaults to monthly, or to the deep-linked interval when present.
  const [intervals, setIntervals] = useState<Record<string, 'month' | 'year'>>(() =>
    directIntervalParam && directPlanParam
      ? { [directPlanParam]: directIntervalParam }
      : {},
  );
  const intervalFor = (plan: string): 'month' | 'year' => intervals[plan] ?? 'month';
  const setIntervalFor = (plan: string, i: 'month' | 'year') =>
    setIntervals((prev) => ({ ...prev, [plan]: i }));

  const [plans, setPlans] = useState<PlanCatalogEntry[]>(FALLBACK_PLANS);
  const [serverBillingEnabled, setServerBillingEnabled] = useState<boolean>(billingEnabled);
  const [talkToSalesOpen, setTalkToSalesOpen] = useState(false);

  // Checkout flow state (ported from the old WelcomePlanPage).
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Agency-without-org sub-form. Activated when the user picks Agency and has
  // no admin org to attach the subscription to. Carries the chosen interval.
  const [teamOrgPrompt, setTeamOrgPrompt] = useState<
    null | { name: string; slug: string; interval: 'month' | 'year' }
  >(null);

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  useEffect(() => {
    if (authChecked && currentUser && !orgsLoaded) loadOrgs();
  }, [authChecked, currentUser, orgsLoaded, loadOrgs]);

  useEffect(() => {
    fetchPlanCatalog()
      .then((res) => {
        if (res.plans?.length) setPlans(res.plans);
        setServerBillingEnabled(res.billingEnabled);
      })
      .catch(() => {
        // Network or backend disabled — keep fallback content.
      });
  }, []);

  const currentPlan: Plan = (currentUser?.plan as Plan | undefined) ?? 'free';
  const onPaidPlan = currentPlan !== 'free' && currentPlan !== 'enterprise';

  // Orgs the user can administer — eligible to host an Agency subscription.
  const adminOrgs: OrgSummary[] = useMemo(
    () => userOrgs.filter((o) => roleAtLeast(o.role, 'admin')),
    [userOrgs],
  );

  // If the caller pinned an org owner (e.g. from /orgs/:slug/billing), require
  // Agency checkout to target that org; otherwise fall back to the user's first
  // admin org, or the org-create flow.
  const presetOrg = useMemo(() => {
    if (presetOwnerType !== 'org' || !presetOwnerId) return null;
    return adminOrgs.find((o) => o.id === presetOwnerId) ?? null;
  }, [presetOwnerType, presetOwnerId, adminOrgs]);

  const recommendedPlan = featureParam ? cheapestPlanFor(featureParam) : null;

  const selfServePlans = useMemo(
    () => plans.filter((p) => p.plan !== 'free' && p.plan !== 'enterprise'),
    [plans],
  );
  const free = plans.find((p) => p.plan === 'free') ?? FALLBACK_PLANS[0];
  const enterprise = plans.find((p) => p.plan === 'enterprise') ?? FALLBACK_PLANS.at(-1)!;
  const orderedCards = [free, ...selfServePlans, enterprise];

  function priceLabel(
    p: PlanCatalogEntry,
    interval: 'month' | 'year',
  ): { amount: string; per: string; sub: string | null } {
    const monthly = p.monthlyPriceUsd;
    const annual = p.annualPriceUsd;
    if (monthly === null || annual === null) return { amount: 'Custom', per: '', sub: null };
    if (interval === 'month') {
      return {
        amount: `$${monthly}`,
        per: p.perSeat ? '/seat/month' : '/month',
        sub: null,
      };
    }
    // Annual selected: show per-month-equivalent so the headline always reads
    // as a monthly cost — never the lump-sum annual total.
    const perMonth = annualToMonthlyEquivalent(annual);
    const saved = annualSavings(monthly, annual);
    const annualFormatted = `$${annual.toLocaleString()}`;
    const sub = saved > 0
      ? `${annualFormatted} billed annually · save $${saved.toLocaleString()}`
      : `${annualFormatted} billed annually`;
    return {
      amount: `$${perMonth}`,
      per: p.perSeat ? '/seat/month' : '/month',
      sub,
    };
  }

  // Kick off Stripe Checkout. Owner mapping is enforced server-side too, but we
  // resolve it here so the redirect happens in a single round-trip.
  async function startPaidCheckout(plan: 'pro' | 'agency', interval: 'month' | 'year', orgId?: string) {
    if (!currentUser) {
      // Logged-out users go straight to sign-up, carrying the plan so they land
      // back here for checkout after verifying their email.
      navigate(`/signup?next=${encodeURIComponent(`/pricing?plan=${plan}&interval=${interval}`)}`);
      return;
    }
    if (!serverBillingEnabled) {
      setError('Billing is not yet enabled in this environment.');
      setPendingPlan(null);
      return;
    }
    setError(null);
    setPendingPlan(plan);
    try {
      const ownerType: 'user' | 'org' = plan === 'agency' ? 'org' : 'user';
      const ownerId = ownerType === 'org' ? (orgId ?? '') : currentUser.id;
      if (ownerType === 'org' && !ownerId) {
        throw new Error('No organization selected.');
      }
      const result = await startCheckout({ ownerType, ownerId, plan, interval });
      window.location.href = result.url;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not start checkout.');
      setPendingPlan(null);
    }
  }

  // Top-level click handler for a paid/free/enterprise tier card.
  async function handlePick(plan: Plan, interval: 'month' | 'year') {
    if (plan === 'free') {
      // "Switch to Free" from an active paid subscription is a cancellation,
      // not a navigation — route through the Customer Portal. An org context
      // (preset from /orgs/:slug/billing) wins, else the user's personal sub.
      let portalOwnerType: 'user' | 'org' | null = null;
      let portalOwnerId: string | null = null;
      if (presetOrg && presetOrg.plan && presetOrg.plan !== 'free' && presetOrg.plan !== 'enterprise') {
        portalOwnerType = 'org';
        portalOwnerId = presetOrg.id;
      } else if (onPaidPlan && currentUser) {
        portalOwnerType = 'user';
        portalOwnerId = currentUser.id;
      }

      if (portalOwnerType && portalOwnerId) {
        setError(null);
        setPendingPlan('free');
        try {
          const res = await openBillingPortal({
            ownerType: portalOwnerType,
            ownerId: portalOwnerId,
            returnUrl: `${window.location.origin}/account/billing`,
          });
          window.location.href = res.url;
          return;
        } catch (e) {
          setError(
            e instanceof ApiError
              ? e.message
              : (e as Error)?.message ?? 'Could not open billing portal to cancel.',
          );
          setPendingPlan(null);
          return;
        }
      }

      navigate(source === 'welcome' ? '/feeds?welcome=1' : '/feeds');
      return;
    }
    if (plan === 'enterprise') {
      trackCtaClick('pricing_talk_to_sales_open');
      setTalkToSalesOpen(true);
      return;
    }
    if (plan === 'agency') {
      // Prefer a pinned org, then the user's existing admin org, else prompt to
      // create one.
      const orgId = presetOrg?.id ?? adminOrgs[0]?.id;
      if (orgId) {
        void startPaidCheckout('agency', interval, orgId);
      } else {
        const defaultName = `${currentUser?.displayName ?? 'My'} Transit`;
        setTeamOrgPrompt({ name: defaultName, slug: slugifyOrgName(defaultName), interval });
      }
      return;
    }
    void startPaidCheckout('pro', interval);
  }

  // Auto-checkout after a deep-link / post-verify return (e.g.
  // /pricing?plan=pro&interval=year). Waits for auth + orgs, fires once, and
  // skips if the user is already on the requested plan. Agency still funnels
  // through the org picker / create form via handlePick.
  useEffect(() => {
    if (autoTriggered) return;
    if (!authChecked || !currentUser) return;
    if (!orgsLoaded) return;
    if (!directPlanParam) return;
    if (directPlanParam !== 'pro' && directPlanParam !== 'agency') {
      setAutoTriggered(true);
      return;
    }
    if (currentPlan === directPlanParam) {
      setAutoTriggered(true);
      return;
    }
    setAutoTriggered(true);
    handlePick(directPlanParam as Plan, directIntervalParam ?? intervalFor(directPlanParam));
    // handlePick is recreated each render; the autoTriggered guard fires once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriggered, authChecked, currentUser, orgsLoaded, directPlanParam, currentPlan]);

  // Submit handler for the inline "Create your organization" form. Creates the
  // org first (plan stays 'free' until the Stripe webhook flips it to 'agency'
  // after Checkout completes), then starts Agency checkout against the new org.
  async function handleCreateOrgAndCheckout() {
    if (!teamOrgPrompt) return;
    const name = teamOrgPrompt.name.trim();
    const slug = slugifyOrgName(teamOrgPrompt.slug || name);
    if (!name) {
      setError('Organization name is required.');
      return;
    }
    setError(null);
    setPendingPlan('agency');
    try {
      const res = await createOrg({ name, slug });
      upsertUserOrg({
        id: res.organization.id,
        slug: res.organization.slug,
        name: res.organization.name,
        role: res.organization.role,
        plan: 'free',
        planStatus: 'active',
        memberCount: 1,
        projectCount: 0,
        createdAt: res.organization.createdAt,
      });
      await startPaidCheckout('agency', teamOrgPrompt.interval, res.organization.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not create organization.');
      setPendingPlan(null);
    }
  }

  // ─── Agency org-create sub-step ───────────────────────────────────────────
  if (teamOrgPrompt) {
    return (
      <AuthLayout
        title="Name your organization"
        subtitle="Agency subscriptions are billed to an organization. We’ll create it now and route the subscription to it."
      >
        <div className="space-y-4">
          <TestModeBanner />
          <FormField
            label="Organization name"
            value={teamOrgPrompt.name}
            onChange={(name) => setTeamOrgPrompt({ ...teamOrgPrompt, name, slug: slugifyOrgName(name) })}
            required
          />
          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              URL slug
            </label>
            <div className="flex items-center gap-2 rounded-lg border-2 border-sand bg-cream px-3 py-2 focus-within:border-coral focus-within:bg-white">
              <span className="text-xs text-warm-gray select-none">/orgs/</span>
              <input
                type="text"
                value={teamOrgPrompt.slug}
                onChange={(e) => setTeamOrgPrompt({ ...teamOrgPrompt, slug: e.target.value })}
                className="flex-1 bg-transparent text-sm text-dark-brown focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-warm-gray">
              Lowercase letters, digits, and dashes. 3–63 characters.
            </p>
          </div>
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <AuthButton
              variant="secondary"
              onClick={() => {
                setTeamOrgPrompt(null);
                setPendingPlan(null);
                setError(null);
              }}
              type="button"
              disabled={pendingPlan === 'agency'}
            >
              Back
            </AuthButton>
            <AuthButton
              onClick={handleCreateOrgAndCheckout}
              type="button"
              disabled={pendingPlan === 'agency' || !teamOrgPrompt.name.trim()}
            >
              {pendingPlan === 'agency' ? 'Creating…' : 'Continue to checkout'}
            </AuthButton>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // ─── Header copy ──────────────────────────────────────────────────────────
  const isWelcome = source === 'welcome';
  const pageTitle = (() => {
    if (isWelcome) return 'Welcome — pick your plan';
    if (featureParam || onPaidPlan) return 'Choose your plan';
    return 'Pricing';
  })();
  const pageSubtitle = (() => {
    if (featureParam && FEATURE_COPY[featureParam]) {
      return `Unlocks ${FEATURE_COPY[featureParam].title.toLowerCase()}: ${FEATURE_COPY[featureParam].description}`;
    }
    if (isWelcome) return 'Your email is verified. Pick the plan that fits — you can always change later.';
    if (onPaidPlan) return `You're on ${planDisplayName(currentPlan)}. Compare tiers or change your plan below.`;
    return 'The fast, free GTFS editor. Paid plans add Premium Feed Management and Route Planning Features.';
  })();

  return (
    <AuthLayout title={pageTitle} subtitle={pageSubtitle} wide>
      <div className="space-y-8">
        <TestModeBanner />
        {!checkoutContext && (
          <div className="text-sm text-warm-gray">
            The editor and GTFS-Flex authoring are always free. Pro adds hosting and publishing; Agency adds the full route-planning suite.
          </div>
        )}

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {orderedCards.map((p) => {
            const isFree = p.plan === 'free';
            const isEnterprise = p.plan === 'enterprise';
            const isCurrent = Boolean(currentUser) && p.plan === currentPlan;
            const recommended = recommendedPlan === p.plan;
            const popular = p.plan === POPULAR_PLAN && !recommendedPlan;
            const isPending = pendingPlan === p.plan;
            // Toggle only shows on paid self-serve plans (both prices exist).
            const showToggle = !isFree && !isEnterprise && p.monthlyPriceUsd !== null && p.annualPriceUsd !== null;
            const cardInterval = intervalFor(p.plan);
            const label = priceLabel(p, cardInterval);
            return (
              <div
                key={p.plan}
                className={`relative flex flex-col rounded-2xl border bg-cream p-5 ${
                  isCurrent
                    ? 'border-teal shadow-lg'
                    : recommended
                      ? 'border-purple shadow-lg'
                      : popular
                        ? 'border-coral shadow-lg'
                        : 'border-sand'
                }`}
              >
                {isCurrent ? (
                  <span className="absolute -top-3 left-4 rounded-full bg-teal px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Your plan
                  </span>
                ) : recommended ? (
                  <span className="absolute -top-3 left-4 rounded-full bg-purple px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Recommended
                  </span>
                ) : popular ? (
                  <span className="absolute -top-3 left-4 rounded-full bg-coral px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Free trial
                  </span>
                ) : null}
                <div>
                  <h3 className="font-heading text-lg font-bold text-dark-brown">{p.displayName}</h3>
                  <p className="mt-1 text-xs text-warm-gray">{p.tagline}</p>
                </div>
                <div className="mt-4">
                  <div className="flex items-baseline gap-1">
                    <span className="font-heading text-3xl font-extrabold text-brown">{label.amount}</span>
                    {label.per && <span className="text-xs text-warm-gray">{label.per}</span>}
                  </div>
                  {label.sub && (
                    <p className="mt-0.5 text-xs text-warm-gray">{label.sub}</p>
                  )}
                  {/* Agency tier ships with a 14-day trial; show it inline so
                      the price doesn't look like a hard commitment. */}
                  {popular && (
                    <p className="mt-1 text-xs font-semibold text-coral">14-day free trial · cancel anytime</p>
                  )}
                  {showToggle && (
                    <div className="mt-3 inline-flex rounded-full border border-sand bg-white p-0.5 text-[11px]">
                      {(['month', 'year'] as const).map((i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setIntervalFor(p.plan, i)}
                          className={`rounded-full px-2.5 py-1 font-semibold transition-colors ${
                            cardInterval === i ? 'bg-coral text-white' : 'text-warm-gray hover:text-brown'
                          }`}
                        >
                          {i === 'month' ? 'Monthly' : 'Annual'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <ul className="mt-4 space-y-2 text-sm text-brown flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-teal">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {p.detailsHref && (
                  // Static content page (e.g. /planning) — full navigation, not an SPA route.
                  <a
                    href={p.detailsHref}
                    className="mt-1 inline-block text-sm font-semibold text-teal hover:underline"
                  >
                    {p.detailsLabel ?? 'Learn more →'}
                  </a>
                )}
                <div className="mt-5">
                  {isCurrent ? (
                    <Link
                      to="/feeds"
                      className="block w-full rounded-lg bg-teal py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#1f7e72]"
                    >
                      Continue to my feeds
                    </Link>
                  ) : isFree ? (
                    currentUser ? (
                      onPaidPlan ? (
                        <AuthButton fullWidth variant="secondary" onClick={() => handlePick('free', cardInterval)}>
                          Switch to Free
                        </AuthButton>
                      ) : (
                        <Link
                          to="/feeds"
                          className="block w-full rounded-lg bg-sand py-2.5 text-center font-heading text-sm font-bold text-brown hover:bg-coral-light hover:text-coral"
                        >
                          Open my feeds
                        </Link>
                      )
                    ) : (
                      <Link
                        to="/signup"
                        className="block w-full rounded-lg bg-sand py-2.5 text-center font-heading text-sm font-bold text-brown hover:bg-coral-light hover:text-coral"
                      >
                        Create free account
                      </Link>
                    )
                  ) : isEnterprise ? (
                    <button
                      type="button"
                      onClick={() => {
                        trackCtaClick('pricing_talk_to_sales_open');
                        setTalkToSalesOpen(true);
                      }}
                      className="block w-full rounded-lg border border-sand bg-cream py-2.5 text-center font-heading text-sm font-bold text-brown hover:border-coral hover:text-coral"
                    >
                      Talk to sales
                    </button>
                  ) : currentUser ? (
                    <AuthButton
                      fullWidth
                      onClick={() => handlePick(p.plan, cardInterval)}
                      disabled={pendingPlan !== null}
                    >
                      {isPending ? 'Redirecting…' : `Upgrade to ${p.displayName}`}
                    </AuthButton>
                  ) : (
                    <AuthButton
                      fullWidth
                      onClick={() =>
                        navigate(
                          `/signup?next=${encodeURIComponent(`/pricing?plan=${p.plan}&interval=${cardInterval}`)}`,
                        )
                      }
                    >
                      {`Start with ${p.displayName}`}
                    </AuthButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {!serverBillingEnabled && (
          <div className="rounded-xl border border-gold bg-gold-light/40 p-4 text-sm text-amber-900">
            Billing is not yet enabled in this environment. Paid checkout will open as soon as we flip
            the switch — you can still create a free account and explore the editor today.
          </div>
        )}

        {checkoutContext ? (
          <div className="text-center">
            <Link
              to={onPaidPlan ? '/account/billing' : '/feeds'}
              className="text-sm text-warm-gray hover:text-coral"
            >
              {onPaidPlan ? '← Back to billing settings' : 'Decide later — take me to the editor →'}
            </Link>
          </div>
        ) : (
          <>
            <section>
              <h2 className="font-heading text-lg font-bold text-dark-brown">Need a hand?</h2>
              <p className="mt-1 text-sm text-warm-gray">
                Prefer to have it done for you? We offer hands-on, done-for-you GTFS work.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="flex flex-col rounded-2xl border border-sand bg-cream p-5">
                  <div>
                    <h3 className="font-heading text-lg font-bold text-dark-brown">Fix my feed for me</h3>
                    <p className="mt-1 text-xs text-warm-gray">
                      We’ll repair validator errors, refresh stale data, and hand back a clean feed ready to publish.
                    </p>
                  </div>
                  <ul className="mt-4 space-y-2 text-sm text-brown flex-1">
                    {[
                      'Diagnose validator errors against your existing feed',
                      'Fix shapes, calendars, fares, and stop placements as needed',
                      'Re-validate and hand back as a ready-to-publish GTFS ZIP',
                      'Most fixes turn around in under a week',
                    ].map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="mt-0.5 text-teal">✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-xs text-warm-gray">
                    Priced per feed after a 10-min scoping call — most jobs land in the $500–$1,500 range.
                  </p>
                  <div className="mt-5 space-y-2">
                    <a
                      href={SCHEDULE_CALL_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackCtaClick('pricing_fix_my_feed_schedule')}
                      className="block w-full rounded-lg bg-coral py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#d4603a]"
                    >
                      Book a scoping call
                    </a>
                    <a
                      href={FIX_FEED_MAIL}
                      onClick={() => trackCtaClick('pricing_fix_my_feed_email')}
                      className="block w-full rounded-lg border border-sand bg-cream py-2.5 text-center font-heading text-sm font-bold text-brown hover:border-coral hover:text-coral"
                    >
                      Or email us your details
                    </a>
                  </div>
                </div>

                <div className="flex flex-col rounded-2xl border border-sand bg-cream p-5">
                  <div>
                    <h3 className="font-heading text-lg font-bold text-dark-brown">Build a feed from scratch</h3>
                    <p className="mt-1 text-xs text-warm-gray">
                      New service, no existing feed — we’ll author it from your schedules and route data.
                    </p>
                  </div>
                  <ul className="mt-4 space-y-2 text-sm text-brown flex-1">
                    {[
                      'Schedule, route geometry, stops, fares',
                      'GTFS-Flex zones and booking rules if you need them',
                      'Validated and ready to register with the Mobility Database',
                      'Scoped against route count and source-data quality',
                    ].map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="mt-0.5 text-teal">✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-xs text-warm-gray">
                    Priced per project after a 10-min scoping call.
                  </p>
                  <div className="mt-5 space-y-2">
                    <a
                      href={SCHEDULE_CALL_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackCtaClick('pricing_build_feed_schedule')}
                      className="block w-full rounded-lg bg-coral py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#d4603a]"
                    >
                      Book a scoping call
                    </a>
                    <a
                      href={BUILD_FEED_MAIL}
                      onClick={() => trackCtaClick('pricing_build_feed_email')}
                      className="block w-full rounded-lg border border-sand bg-cream py-2.5 text-center font-heading text-sm font-bold text-brown hover:border-coral hover:text-coral"
                    >
                      Or email us your details
                    </a>
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs text-warm-gray">
                Services delivered by Mark Egge (
                <a
                  href="https://vectorvertex.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-brown underline hover:text-coral"
                >
                  Vector &amp; Vertex
                </a>
                ) — AICP-certified transit planner, GTFS·X founder.
              </p>
            </section>

            <section>
              <h2 className="font-heading text-lg font-bold text-dark-brown">How GTFS·X compares</h2>
              <p className="mt-1 text-sm text-warm-gray">
                Honest comparisons with the other GTFS authoring tools agencies evaluate.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Link
                  to="/compare/trillium/"
                  className="block rounded-2xl border border-sand bg-cream p-4 hover:border-coral"
                >
                  <div className="font-heading text-sm font-bold text-dark-brown">vs. Trillium (Optibus)</div>
                  <p className="mt-1 text-xs text-warm-gray">Managed GTFS service vs. self-serve editor — cost, control, fit.</p>
                </Link>
                <Link
                  to="/compare/remix/"
                  className="block rounded-2xl border border-sand bg-cream p-4 hover:border-coral"
                >
                  <div className="font-heading text-sm font-bold text-dark-brown">vs. Remix by Via</div>
                  <p className="mt-1 text-xs text-warm-gray">Network planning suite vs. GTFS-first tool — where each one fits.</p>
                </Link>
                <Link
                  to="/compare/gtfs-builder-rtap/"
                  className="block rounded-2xl border border-sand bg-cream p-4 hover:border-coral"
                >
                  <div className="font-heading text-sm font-bold text-dark-brown">vs. National RTAP GTFS Builder</div>
                  <p className="mt-1 text-xs text-warm-gray">Free spreadsheet builder vs. map-based editor — when to use which.</p>
                </Link>
                <Link
                  to="/compare/spare-flex-builder/"
                  className="block rounded-2xl border border-sand bg-cream p-4 hover:border-coral"
                >
                  <div className="font-heading text-sm font-bold text-dark-brown">vs. Spare GTFS-Flex Builder</div>
                  <p className="mt-1 text-xs text-warm-gray">Microtransit-only builder vs. full GTFS + Flex authoring.</p>
                </Link>
              </div>
            </section>

            <section className="rounded-2xl border border-sand bg-cream p-6">
              <h2 className="font-heading text-lg font-bold text-dark-brown">FAQ</h2>
              <div className="mt-3 space-y-3 text-sm text-brown">
                <div>
                  <p className="font-semibold">Can I keep using the editor for free?</p>
                  <p className="text-warm-gray">
                    Yes. The browser-based editor, GTFS-Flex authoring, and ZIP export stay free forever — sign
                    up to save up to 3 feeds in the cloud, or stay anonymous and keep everything in your browser.
                  </p>
                </div>
                <div>
                  <p className="font-semibold">What&rsquo;s included in Premium Feed Management?</p>
                  <p className="text-warm-gray">
                    We host your feed at <code>feeds.gtfsx.com/&lt;slug&gt;/gtfs.zip</code> — a stable
                    URL you can hand to the Mobility Database, riders, or regulators. We also generate a
                    rider-facing mini-site, embed widgets you can drop on your own website, draft preview
                    links for stakeholder review, and validation + expiry monitoring.
                  </p>
                </div>
                <div>
                  <p className="font-semibold">What&rsquo;s included in Route Planning Features?</p>
                  <p className="text-warm-gray">
                    Cost estimation (revenue hours, peak vehicles, weekly + annual operating cost),
                    demographic coverage from US Census ACS, a nationwide demand-propensity map layer,
                    Title VI equity analysis using the FTA four-fifths threshold, and snapshot-based
                    scenario comparison so you can save and compare multiple feed versions.
                  </p>
                </div>
                <div>
                  <p className="font-semibold">Do you offer non-profit or educational discounts?</p>
                  <p className="text-warm-gray">
                    Not for v1 — published prices apply to all customers. Get in touch about strategic
                    partnerships and we’ll consider it case by case.
                  </p>
                </div>
                <div>
                  <p className="font-semibold">What if I need to cancel?</p>
                  <p className="text-warm-gray">
                    Cancel any time from your billing portal. We honor a 30-day no-questions prorated refund
                    from the start of a billing period; after that, cancellation stops future billing only.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
      <TalkToSalesModal
        open={talkToSalesOpen}
        onClose={() => setTalkToSalesOpen(false)}
        scheduleUrl={SCHEDULE_CALL_URL}
        mailto={ENTERPRISE_MAIL}
      />
    </AuthLayout>
  );
}
