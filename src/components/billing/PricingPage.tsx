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

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useStore } from '../../store';
import {
  fetchPlanCatalog,
  openBillingPortal,
  startCheckout,
  startTrial,
  type PlanCatalogEntry,
  type Plan,
} from '../../services/billingApi';
import { createOrg, roleAtLeast, type OrgSummary } from '../../services/orgsApi';
import { ApiError } from '../../services/authApi';
import { trackCtaClick } from '../../services/trackBeacon';
import { planDisplayName, cheapestPlanFor, FEATURE_COPY, type FeatureKey } from './planConfig';
import {
  canHostTrial,
  deriveTrialOrgName,
  resolveTrialStart,
  slugifyOrgName,
  trialWorkspaceSlug,
} from './orgTrial';
import {
  annualToMonthlyEquivalent,
  annualSavings,
  redirectModalState,
  redirectModalCopy,
  type AutoCheckoutPhase,
} from './pricingUtils';
import { TestModeBanner } from './TestModeBanner';
import { TalkToSalesModal } from './TalkToSalesModal';

// Fallback catalog used when the worker is unreachable (e.g. /pricing rendered
// before backend is enabled). Kept in sync with worker/billing/plans.ts.
const FALLBACK_PLANS: PlanCatalogEntry[] = [
  {
    plan: 'free',
    displayName: 'Editor',
    monthlyPriceUsd: 0,
    annualPriceUsd: 0,
    perSeat: false,
    tagline: 'Create, edit, validate, and export GTFS feeds—free.',
    features: [
      'Create and edit routes, stops, trips, and schedules on a live map',
      'Add GTFS-Flex zones and booking rules to any feed',
      'Validate against the GTFS spec as you work',
      'Import an existing feed or start from scratch (no signup required)',
      'Export a spec-clean GTFS .zip and host it anywhere',
    ],
  },
  {
    plan: 'agency',
    displayName: 'Planner',
    monthlyPriceUsd: 299,
    annualPriceUsd: 2988,
    perSeat: false,
    tagline: 'The service-planning suite for transit agencies.',
    features: [
      'Route operating cost estimates',
      'Demographic coverage & Title VI equity analysis',
      'Scenario comparison',
      'Hosted publishing: stable feed URL, rider mini-site & embeds',
      'Unlimited feeds & team workspaces',
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
    tagline: 'Multi-agency subscriptions for consultants and state DOTs',
    features: [
      'Everything in Planner',
      'Multi-agency feed portfolios',
      'Higher limits and SLA',
      'Contract via PO or invoice',
    ],
  },
];

const POPULAR_PLAN: Plan = 'agency';

// Enterprise card bullets are display-only and fixed here (the live catalog's
// enterprise entry carries longer sales copy meant for /docs/pricing) so the
// card stays short regardless of catalog contents.
const ENTERPRISE_FEATURES = [
  'Everything in Planner',
  'Multi-agency feed portfolios',
  'Higher limits and SLA',
  'Contract via PO or invoice',
] as const;

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
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const setCurrentUser = useStore((s) => s.setCurrentUser);

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
  // monthly vs annual side-by-side. Keyed by plan id;
  // defaults to monthly, or to the deep-linked interval when present.
  const [intervals, setIntervals] = useState<Record<string, 'month' | 'year'>>(() =>
    directIntervalParam && directPlanParam
      ? { [directPlanParam]: directIntervalParam }
      : {},
  );
  const intervalFor = (plan: string): 'month' | 'year' => intervals[plan] ?? 'year';
  const setIntervalFor = (plan: string, i: 'month' | 'year') =>
    setIntervals((prev) => ({ ...prev, [plan]: i }));

  const [plans, setPlans] = useState<PlanCatalogEntry[]>(FALLBACK_PLANS);
  const [talkToSalesOpen, setTalkToSalesOpen] = useState(false);
  // Which flow opened the modal — picks the prefilled mailto (Enterprise
  // inquiry vs. fix-my-feed scoping). Same booking link either way.
  const [talkToSalesContext, setTalkToSalesContext] = useState<'enterprise' | 'services'>('enterprise');

  // Checkout flow state (ported from the old WelcomePlanPage).
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drives the redirect modal that covers the page while a deep-linked
  // (auto-triggered) checkout is creating its Stripe session. Only the auto
  // path sets this — manual card clicks keep their in-button "Redirecting…"
  // state so the manual flow is left unchanged.
  const [autoCheckoutPhase, setAutoCheckoutPhase] = useState<AutoCheckoutPhase>('idle');
  // Agency-without-org sub-form. Activated when the user picks Agency (to start
  // a trial OR to subscribe) and has no admin org to attach it to. `mode`
  // decides what happens after the org is created.
  const [teamOrgPrompt, setTeamOrgPrompt] = useState<
    null | { name: string; slug: string; interval: 'month' | 'year'; mode: 'trial' | 'checkout' }
  >(null);
  // In-app no-card trial flow state.
  const [trialPending, setTrialPending] = useState(false);
  const [trialStarted, setTrialStarted] = useState<
    null | { orgName: string; orgSlug: string; trialEndsAt: number }
  >(null);
  // Rare multi-org case: which of the user's eligible admin orgs hosts the trial.
  const [trialPicker, setTrialPicker] = useState(false);

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
      })
      .catch(() => {
        // Network or backend disabled — keep fallback content.
      });
  }, []);

  const currentPlan: Plan = (currentUser?.plan as Plan | undefined) ?? 'free';
  const onPaidPlan = currentPlan !== 'free' && currentPlan !== 'enterprise';

  // Orgs the user can administer — eligible to host a Planner subscription.
  const adminOrgs: OrgSummary[] = useMemo(
    () => userOrgs.filter((o) => roleAtLeast(o.role, 'admin')),
    [userOrgs],
  );

  // If the caller pinned an org owner (e.g. from /orgs/:slug/billing), require
  // Planner checkout to target that org; otherwise fall back to the user's first
  // admin org, or the org-create flow.
  const presetOrg = useMemo(() => {
    if (presetOwnerType !== 'org' || !presetOwnerId) return null;
    return adminOrgs.find((o) => o.id === presetOwnerId) ?? null;
  }, [presetOwnerType, presetOwnerId, adminOrgs]);

  const recommendedPlan = featureParam ? cheapestPlanFor(featureParam) : null;

  // No-credit-card trial eligibility (best-effort client gate; the server is
  // authoritative). The primary CTA is the trial when the user hasn't burned
  // their one trial. Which org hosts it is resolved at click time
  // (resolveTrialStart): a pinned org, the single eligible admin org, a silent
  // auto-created workspace, or a picker for the rare multi-org case.
  const trialUsed = Boolean(currentUser?.trialUsed);
  // Admin orgs with no existing plan — the ones that could host a fresh trial.
  const eligibleTrialOrgs = useMemo(
    () => adminOrgs.filter((o) => canHostTrial(o)),
    [adminOrgs],
  );
  // The only hard client-side block: a pinned org (org-scoped entry) that is
  // already on a plan can't be trialed. Everything else can start a trial
  // (auto-creating a workspace if the user has none).
  const pinnedTrialBlocked = Boolean(presetOrg && !canHostTrial(presetOrg));
  const canOfferTrial = Boolean(currentUser) && !trialUsed && !pinnedTrialBlocked;

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
    if (monthly === null || annual === null) return { amount: 'Call us', per: '', sub: null };
    if (monthly === 0 && annual === 0) return { amount: 'Free Forever', per: '', sub: null };
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
  // resolve it here so the redirect happens in a single round-trip. `viaAuto`
  // marks the deep-link / post-verify auto-trigger path so we cover the page
  // with the redirect modal (and surface a create failure in it) instead of
  // only flipping the card button to "Redirecting…".
  async function startPaidCheckout(
    plan: 'agency',
    interval: 'month' | 'year',
    orgId?: string,
    viaAuto = false,
  ) {
    if (!currentUser) {
      // Logged-out users go straight to sign-up, carrying the plan so they land
      // back here for checkout after verifying their email.
      navigate(`/signup?next=${encodeURIComponent(`/pricing?plan=${plan}&interval=${interval}`)}`);
      return;
    }
    setError(null);
    setPendingPlan(plan);
    if (viaAuto) setAutoCheckoutPhase('starting');
    try {
      // Planner (internal id 'agency') is always billed to an organization.
      const ownerId = orgId ?? '';
      if (!ownerId) {
        throw new Error('No organization selected.');
      }
      const result = await startCheckout({ ownerType: 'org', ownerId, plan, interval });
      window.location.href = result.url;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not start checkout.');
      setPendingPlan(null);
      if (viaAuto) setAutoCheckoutPhase('error');
    }
  }

  // Top-level click handler for a paid/free/enterprise tier card. `viaAuto`
  // (set only by the deep-link auto-trigger) flows through to Planner checkout
  // so the redirect modal covers the hand-off; when Planner has no org yet we
  // fall through to the org-create form instead, where no modal is wanted.
  async function handlePick(
    plan: Plan,
    interval: 'month' | 'year',
    opts?: { viaAuto?: boolean },
  ) {
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
      setTalkToSalesContext('enterprise');
      setTalkToSalesOpen(true);
      return;
    }
    // Planner (internal id 'agency'): prefer a pinned org, then the user's
    // existing admin org, else prompt to create one.
    const orgId = presetOrg?.id ?? adminOrgs[0]?.id;
    if (orgId) {
      void startPaidCheckout('agency', interval, orgId, opts?.viaAuto);
    } else {
      // No org to bill yet: show the create-org form. This is an expected input
      // step, not a surprise redirect, so we don't raise the redirect modal.
      const defaultName = `${currentUser?.displayName ?? 'My'} Transit`;
      setTeamOrgPrompt({ name: defaultName, slug: slugifyOrgName(defaultName), interval, mode: 'checkout' });
    }
  }

  // Auto-checkout after a deep-link / post-verify return (e.g.
  // /pricing?plan=agency&interval=year). Waits for auth + orgs, fires once, and
  // skips if the user is already on the requested plan.
  useEffect(() => {
    if (autoTriggered) return;
    if (!authChecked || !currentUser) return;
    if (!orgsLoaded) return;
    if (!directPlanParam) return;
    if (directPlanParam !== 'agency') {
      setAutoTriggered(true);
      return;
    }
    if (currentPlan === directPlanParam) {
      setAutoTriggered(true);
      return;
    }
    // A trial-eligible user must NOT be auto-redirected to card checkout — that
    // would contradict the "no credit card required" promise. Land them on the
    // page with the no-card trial CTA prominent instead of auto-firing Stripe.
    if (canOfferTrial) {
      setAutoTriggered(true);
      return;
    }
    setAutoTriggered(true);
    handlePick(directPlanParam as Plan, directIntervalParam ?? intervalFor(directPlanParam), {
      viaAuto: true,
    });
    // handlePick is recreated each render; the autoTriggered guard fires once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriggered, authChecked, currentUser, orgsLoaded, directPlanParam, currentPlan]);

  // Re-run the deep-linked checkout after a create failure (Retry in the
  // redirect modal). Mirrors the auto-trigger effect's call, minus the run-once
  // guard, so it re-enters startPaidCheckout via the same viaAuto path.
  function retryAutoCheckout() {
    if (directPlanParam !== 'agency') return;
    setError(null);
    setAutoCheckoutPhase('idle');
    handlePick('agency', directIntervalParam ?? intervalFor('agency'), { viaAuto: true });
  }

  // Dismiss the redirect modal after a failure and clear the error so the user
  // lands back on the normal pricing page to choose manually.
  function dismissAutoCheckout() {
    setAutoCheckoutPhase('idle');
    setError(null);
  }

  // Submit handler for the inline "Create your organization" form. Creates the
  // org first, then either starts the in-app no-card trial on it (mode:'trial')
  // or starts Planner checkout against it (mode:'checkout' — plan stays 'free'
  // until the Stripe webhook flips it to 'agency').
  async function handleCreateOrgAndCheckout() {
    if (!teamOrgPrompt) return;
    const name = teamOrgPrompt.name.trim();
    const slug = slugifyOrgName(teamOrgPrompt.slug || name);
    if (!name) {
      setError('Organization name is required.');
      return;
    }
    const isTrial = teamOrgPrompt.mode === 'trial';
    setError(null);
    if (isTrial) setTrialPending(true);
    else setPendingPlan('agency');
    try {
      const res = await createOrg({ name, slug });
      const created: OrgSummary = {
        id: res.organization.id,
        slug: res.organization.slug,
        name: res.organization.name,
        role: res.organization.role,
        plan: 'free',
        planStatus: 'active',
        memberCount: 1,
        projectCount: 0,
        createdAt: res.organization.createdAt,
      };
      upsertUserOrg(created);
      if (isTrial) {
        await runTrial(created);
      } else {
        await startPaidCheckout('agency', teamOrgPrompt.interval, res.organization.id);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not create organization.');
      if (isTrial) setTrialPending(false);
      else setPendingPlan(null);
    }
  }

  // Start the no-credit-card Planner trial on an org the user administers.
  // Reflects the new plan into the store immediately (upsert + switch the
  // active workspace) so the editor unlocks without a reload, marks the user as
  // having used their trial, and shows the success state.
  async function runTrial(org: OrgSummary) {
    setError(null);
    setTrialPending(true);
    try {
      const res = await startTrial(org.id);
      upsertUserOrg({
        ...org,
        plan: 'agency',
        planStatus: 'active',
        planExpiresAt: res.trialEndsAt,
        trialEndsAt: res.trialEndsAt,
      });
      setActiveWorkspace({ type: 'org', orgId: org.id, role: org.role });
      if (currentUser) setCurrentUser({ ...currentUser, trialUsed: true });
      setTeamOrgPrompt(null);
      setTrialPicker(false);
      setTrialStarted({ orgName: org.name, orgSlug: org.slug, trialEndsAt: res.trialEndsAt });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not start your trial.');
    } finally {
      setTrialPending(false);
    }
  }

  // Create a workspace to host the trial, silently, for a user with no org.
  // Retries once with a unique suffix if the derived slug is already taken so a
  // common default name can't dead-end the frictionless one-click trial.
  async function createTrialWorkspace(name: string): Promise<OrgSummary> {
    const baseSlug = slugifyOrgName(name);
    for (let attempt = 0; attempt < 2; attempt++) {
      const slug = trialWorkspaceSlug(baseSlug, attempt);
      try {
        const res = await createOrg({ name, slug });
        const created: OrgSummary = {
          id: res.organization.id,
          slug: res.organization.slug,
          name: res.organization.name,
          role: res.organization.role,
          plan: 'free',
          planStatus: 'active',
          memberCount: 1,
          projectCount: 0,
          createdAt: res.organization.createdAt,
        };
        upsertUserOrg(created);
        return created;
      } catch (e) {
        // Slug collision on the first, pretty slug → retry with a suffix.
        if (attempt === 0 && e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) continue;
        throw e;
      }
    }
    throw new Error('Could not create your workspace.');
  }

  // Auto-create a workspace then start the trial in it — no interstitial. Used
  // when the user has no org to host the trial (the common solo case).
  async function autoCreateAndRunTrial() {
    if (!currentUser) return;
    setError(null);
    setTrialPending(true);
    try {
      const org = await createTrialWorkspace(deriveTrialOrgName(currentUser));
      await runTrial(org);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not start your trial.');
      setTrialPending(false);
    }
  }

  // Primary CTA for the Planner card: start the no-card trial with as little
  // friction as possible. resolveTrialStart picks the path — start in the one
  // eligible org (single click), silently auto-create a workspace when the user
  // has none, or (rarely) ask which org when several qualify. Logged-out users
  // go to sign-up first.
  async function handleStartTrial() {
    if (!currentUser) {
      navigate(`/signup?next=${encodeURIComponent('/pricing?source=welcome')}`);
      return;
    }
    const action = resolveTrialStart(presetOrg, eligibleTrialOrgs);
    switch (action.kind) {
      case 'blocked':
        setError('This organization already has a plan.');
        return;
      case 'use':
        await runTrial(action.org);
        return;
      case 'create':
        await autoCreateAndRunTrial();
        return;
      case 'pick':
        setError(null);
        setTrialPicker(true);
        return;
    }
  }

  // ─── Trial started — success sub-step ─────────────────────────────────────
  if (trialStarted) {
    const endsLabel = new Date(trialStarted.trialEndsAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return (
      <AuthLayout
        title="Your Planner trial is active"
        subtitle="No credit card required. You have full access to the planning suite for the next 14 days."
      >
        <div className="space-y-4">
          <TestModeBanner />
          <div className="rounded-xl border border-teal bg-teal/5 px-4 py-4 text-sm text-brown">
            <p className="font-semibold text-dark-brown">{trialStarted.orgName} is on Planner until {endsLabel}.</p>
            <p className="mt-1 text-warm-gray">
              When the trial ends your workspace drops back to the free Editor automatically. Nothing is charged.
              Subscribe any time to keep Planner.
            </p>
          </div>
          <Link
            to="/feeds"
            className="block w-full rounded-lg bg-teal py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#1f7e72]"
          >
            Open the editor →
          </Link>
          <Link
            to={`/orgs/${encodeURIComponent(trialStarted.orgSlug)}/billing`}
            className="block text-center text-xs font-semibold text-warm-gray hover:text-coral"
          >
            View trial &amp; billing for {trialStarted.orgName}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  // ─── Trial org picker (rare: user administers 2+ trial-eligible orgs) ─────
  if (trialPicker) {
    return (
      <AuthLayout
        title="Where should your trial go?"
        subtitle="Planner runs in a workspace. Pick which one starts its free 14-day trial — no credit card required."
      >
        <div className="space-y-4">
          <TestModeBanner />
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="space-y-2">
            {eligibleTrialOrgs.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => runTrial(org)}
                disabled={trialPending}
                className="flex w-full items-center justify-between rounded-lg border-2 border-sand bg-cream px-4 py-3 text-left hover:border-coral disabled:opacity-50"
              >
                <span className="font-semibold text-dark-brown">{org.name}</span>
                <span className="text-xs font-semibold text-teal">Start trial →</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setTrialPicker(false);
              const defaultName = deriveTrialOrgName(currentUser!);
              setError(null);
              setTeamOrgPrompt({ name: defaultName, slug: slugifyOrgName(defaultName), interval: 'year', mode: 'trial' });
            }}
            disabled={trialPending}
            className="block w-full text-center text-xs font-semibold text-warm-gray hover:text-coral disabled:opacity-50"
          >
            Or create a new workspace for the trial
          </button>
          <div className="flex justify-end pt-1">
            <AuthButton
              variant="secondary"
              type="button"
              onClick={() => {
                setTrialPicker(false);
                setError(null);
              }}
              disabled={trialPending}
            >
              Back
            </AuthButton>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // ─── Planner org-create sub-step (trial or checkout) ──────────────────────
  if (teamOrgPrompt) {
    const isTrialMode = teamOrgPrompt.mode === 'trial';
    const busy = isTrialMode ? trialPending : pendingPlan === 'agency';
    return (
      <AuthLayout
        title="Name your organization"
        subtitle={
          isTrialMode
            ? "Planner is organized around a workspace. We'll create yours now and start your free trial in it. No credit card required."
            : "Planner subscriptions are billed to an organization. We'll create it now and route the subscription to it."
        }
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
              disabled={busy}
            >
              Back
            </AuthButton>
            <AuthButton
              onClick={handleCreateOrgAndCheckout}
              type="button"
              disabled={busy || !teamOrgPrompt.name.trim()}
            >
              {isTrialMode
                ? busy
                  ? 'Starting your trial…'
                  : 'Start free trial'
                : busy
                  ? 'Creating…'
                  : 'Continue to checkout'}
            </AuthButton>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // ─── Header copy ──────────────────────────────────────────────────────────
  const isWelcome = source === 'welcome';
  const pageTitle = (() => {
    if (isWelcome) return 'Welcome—pick your plan';
    if (featureParam || onPaidPlan) return 'Choose your plan';
    return 'Pricing';
  })();
  const pageSubtitle = (() => {
    if (featureParam && FEATURE_COPY[featureParam]) {
      return `Unlocks ${FEATURE_COPY[featureParam].title.toLowerCase()}: ${FEATURE_COPY[featureParam].description}`;
    }
    if (isWelcome) return 'Your email is verified. Pick the plan that fits—you can always change later.';
    if (onPaidPlan) return `You're on ${planDisplayName(currentPlan)}. Compare tiers or change your plan below.`;
    return 'The Editor is free forever. Planner adds hosted publishing and the service-planning suite for transit agencies.';
  })();

  // Redirect modal that covers the page during a deep-linked auto-checkout. The
  // plan being sent to Stripe drives the copy — pendingPlan while creating,
  // falling back to the deep-link param once it clears on failure.
  const redirectModal = redirectModalState(autoCheckoutPhase);
  const redirectPlan: Plan | null = pendingPlan ?? (directPlanParam as Plan | null);
  const redirectCopy = redirectModalCopy(
    redirectPlan,
    redirectPlan ? planDisplayName(redirectPlan) : 'your plan',
  );

  return (
    <AuthLayout title={pageTitle} subtitle={pageSubtitle} wide>
      <div className="space-y-8">
        <TestModeBanner />

        {/* Auto-checkout failures are surfaced inside the redirect modal, so
            suppress the inline banner then to avoid showing the error twice. */}
        {error && autoCheckoutPhase !== 'error' && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Editor / Planner / Enterprise—three-up grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {orderedCards.map((p) => {
            const isFree = p.plan === 'free';
            const isCurrent = Boolean(currentUser) && p.plan === currentPlan;
            const recommended = recommendedPlan === p.plan;
            const popular = p.plan === POPULAR_PLAN && !recommendedPlan;
            const isPending = pendingPlan === p.plan;
            // Toggle only shows on paid self-serve plans (both prices exist).
            const showToggle = !isFree && p.monthlyPriceUsd !== null && p.annualPriceUsd !== null;
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
                  {/* Interval toggle rides the price baseline row instead of
                      its own stacked row — keeps the card compact. */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-baseline gap-1">
                      <span className="font-heading text-3xl font-extrabold text-brown">{label.amount}</span>
                      {label.per && <span className="text-xs text-warm-gray">{label.per}</span>}
                    </div>
                    {showToggle && (
                      <div className="inline-flex shrink-0 rounded-full border border-sand bg-white p-0.5 text-[11px]">
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
                  {label.sub && (
                    <p className="mt-0.5 text-xs text-warm-gray">{label.sub}</p>
                  )}
                  {/* Planner ships with a no-card 14-day trial; show it inline
                      so the price doesn't look like a hard commitment. */}
                  {popular && (
                    <p className="mt-1 text-xs font-semibold text-coral">14-day free trial · no credit card required</p>
                  )}
                </div>
                <div className="mt-4 flex-1 text-sm text-brown">
                  {p.plan === 'agency' && (
                    <p className="mb-2 font-semibold text-dark-brown">Everything in Editor, plus:</p>
                  )}
                  <ul className="space-y-2">
                    {(p.plan === 'enterprise' ? ENTERPRISE_FEATURES : p.features).map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="mt-0.5 text-teal">✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {p.detailsHref && (
                    // Static content page (e.g. /planning)—full navigation, not an SPA route.
                    <a
                      href={p.detailsHref}
                      className="mt-2.5 inline-block text-sm font-semibold text-teal hover:underline"
                    >
                      {p.detailsLabel ?? 'Learn more →'}
                    </a>
                  )}
                </div>
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
                  ) : p.plan === 'enterprise' ? (
                    // Sales-led: opens the TalkToSalesModal for logged-in and
                    // logged-out visitors alike (handlePick fires the
                    // pricing_talk_to_sales_open CTA event).
                    <AuthButton
                      fullWidth
                      variant="secondary"
                      onClick={() => handlePick('enterprise', cardInterval)}
                    >
                      Talk to sales
                    </AuthButton>
                  ) : currentUser ? (
                    p.plan === 'agency' && canOfferTrial ? (
                      // Primary path: start the no-credit-card in-app trial.
                      // Subscribing with a card stays available as a secondary
                      // action just below.
                      <div className="space-y-2">
                        <AuthButton
                          fullWidth
                          onClick={handleStartTrial}
                          disabled={trialPending || pendingPlan !== null}
                        >
                          {trialPending ? 'Starting your trial…' : 'Start free trial'}
                        </AuthButton>
                        <p className="text-center text-[11px] font-semibold text-teal">
                          No credit card required
                        </p>
                        <button
                          type="button"
                          onClick={() => handlePick('agency', cardInterval)}
                          disabled={pendingPlan !== null || trialPending}
                          className="block w-full text-center text-xs font-semibold text-warm-gray hover:text-coral disabled:opacity-50"
                        >
                          {isPending ? 'Redirecting…' : 'Or subscribe now with a card'}
                        </button>
                      </div>
                    ) : (
                      <AuthButton
                        fullWidth
                        onClick={() => handlePick(p.plan, cardInterval)}
                        disabled={pendingPlan !== null}
                      >
                        {isPending ? 'Redirecting…' : `Upgrade to ${p.displayName}`}
                      </AuthButton>
                    )
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

        <div className="text-center">
          <a
            href="/docs/pricing/"
            className="text-sm text-warm-gray hover:text-coral"
          >
            View a detailed description of all plans and features →
          </a>
        </div>

        {checkoutContext ? (
          <div className="text-center">
            <Link
              to={onPaidPlan ? '/account/billing' : '/feeds'}
              className="text-sm text-warm-gray hover:text-coral"
            >
              {onPaidPlan ? '← Back to billing settings' : 'Decide later—take me to the editor →'}
            </Link>
          </div>
        ) : (
          <>
            <section>
              <h2 className="font-heading text-lg font-bold text-dark-brown">Need a hand?</h2>
              <p className="mt-1 text-sm text-warm-gray">
                Prefer to have it done for you? We offer hands-on, done-for-you GTFS work.
              </p>
              <div className="mt-4">
                <div className="flex flex-col rounded-2xl border border-sand bg-cream p-5">
                  <div>
                    <h3 className="font-heading text-lg font-bold text-dark-brown">Fix my feed for me</h3>
                    <p className="mt-1 text-xs text-warm-gray">
                      We'll repair validator errors, refresh stale data, and hand back a clean feed ready to publish.
                    </p>
                  </div>
                  <ul className="mt-4 space-y-2 text-sm text-brown flex-1">
                    {[
                      'Diagnose validator errors against your existing feed',
                      'Fix shapes, calendars, fares, and stop placements as needed',
                      'Re-validate and hand back as a ready-to-publish GTFS ZIP',
                    ].map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="mt-0.5 text-teal">✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                    <li className="flex items-start gap-2">
                      <span className="mt-0.5 text-teal">✓</span>
                      <span>
                        Most fixes turn around in under a week.{' '}
                        <a
                          href={BUILD_FEED_MAIL}
                          onClick={() => trackCtaClick('pricing_build_feed_email')}
                          className="font-semibold text-brown underline hover:text-coral"
                        >
                          Or, build a feed from scratch.
                        </a>
                      </span>
                    </li>
                  </ul>
                  <p className="mt-4 text-xs text-warm-gray">
                    Priced per feed after a 10-min scoping call. Most jobs land in the $500–$1,500 range.
                  </p>
                  <div className="mt-5">
                    <button
                      type="button"
                      onClick={() => {
                        trackCtaClick('pricing_fix_my_feed_talk_open');
                        setTalkToSalesContext('services');
                        setTalkToSalesOpen(true);
                      }}
                      className="block w-full rounded-lg bg-coral py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#d4603a]"
                    >
                      Talk to sales
                    </button>
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
                )—AICP-certified transit planner, GTFS·X founder.
              </p>
            </section>

            <section className="rounded-2xl border border-sand bg-cream p-6">
              <h2 className="font-heading text-lg font-bold text-dark-brown">FAQ</h2>
              <div className="mt-3 divide-y divide-sand">
                {([
                  {
                    q: 'Can I keep using the editor for free?',
                    a: (
                      <p className="mt-2 text-sm text-warm-gray">
                        Yes. The browser-based editor, GTFS-Flex authoring, and ZIP export stay free forever. Sign
                        up to save up to 3 feeds in the cloud, or stay anonymous and keep everything in your browser.
                      </p>
                    ),
                  },
                  {
                    q: 'How does the 14-day free trial work?',
                    a: (
                      <p className="mt-2 text-sm text-warm-gray">
                        Planner trials get full access for 14 days with no credit card required. When the trial
                        ends your workspace drops back to the free Editor automatically and nothing is charged.
                        Subscribe any time during or after the trial to keep Planner.
                      </p>
                    ),
                  },
                  {
                    q: 'What if I need to cancel?',
                    a: (
                      <p className="mt-2 text-sm text-warm-gray">
                        Cancel any time from your billing portal. We honor a 30-day no-questions prorated refund
                        from the start of a billing period; after that, cancellation stops future billing only.
                      </p>
                    ),
                  },
                  {
                    q: 'Can my agency pay by PO or invoice instead of a card?',
                    a: (
                      <p className="mt-2 text-sm text-warm-gray">
                        Card checkout keeps Planner below most micro-purchase thresholds, so many agencies can buy
                        it on a P-card with no procurement cycle. If your agency requires a PO or invoice,
                        Enterprise agreements support both—{' '}
                        <button
                          type="button"
                          onClick={() => {
                            trackCtaClick('pricing_faq_talk_to_sales');
                            setTalkToSalesContext('enterprise');
                            setTalkToSalesOpen(true);
                          }}
                          className="font-semibold text-teal underline hover:text-coral"
                        >
                          talk to sales
                        </button>
                        .
                      </p>
                    ),
                  },
                ] as { q: string; a: React.ReactNode }[]).map(({ q, a }) => (
                  <details key={q} className="group py-3 first:pt-0 last:pb-0">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-brown [&::-webkit-details-marker]:hidden">
                      <span>{q}</span>
                      <span className="shrink-0 text-base leading-none text-warm-gray transition-transform duration-150 group-open:rotate-180">
                        ▾
                      </span>
                    </summary>
                    {a}
                  </details>
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-sand space-y-1.5">
                <a
                  href="/docs/pricing/"
                  className="block text-sm font-semibold text-teal hover:underline"
                >
                  See the full plan and feature breakdown →
                </a>
                <p className="text-xs text-warm-gray">
                  Comparing tools? GTFS·X vs.{' '}
                  <Link to="/compare/trillium/" className="font-semibold text-brown underline hover:text-coral">Trillium</Link>,{' '}
                  <Link to="/compare/remix/" className="font-semibold text-brown underline hover:text-coral">Remix</Link>,{' '}
                  <Link to="/compare/gtfs-builder-rtap/" className="font-semibold text-brown underline hover:text-coral">RTAP GTFS Builder</Link>, and{' '}
                  <Link to="/compare/spare-flex-builder/" className="font-semibold text-brown underline hover:text-coral">Spare Flex Builder</Link>.
                </p>
              </div>
            </section>
          </>
        )}
      </div>
      <TalkToSalesModal
        open={talkToSalesOpen}
        onClose={() => setTalkToSalesOpen(false)}
        scheduleUrl={SCHEDULE_CALL_URL}
        mailto={talkToSalesContext === 'services' ? FIX_FEED_MAIL : ENTERPRISE_MAIL}
      />

      {/* Deep-link auto-checkout: cover the page so the hand-off to Stripe is
          explained, not a surprise. Locked (non-dismissable) while creating the
          session; on failure it swaps to an error state with Retry/Close rather
          than stranding the spinner. */}
      <Modal
        open={redirectModal.open}
        onClose={dismissAutoCheckout}
        dismissable={false}
        showClose={redirectModal.variant === 'error'}
        title={redirectModal.variant === 'error' ? "We couldn't start your checkout" : redirectCopy.title}
        footer={
          redirectModal.variant === 'error' ? (
            <>
              <AuthButton variant="secondary" type="button" onClick={dismissAutoCheckout}>
                Close
              </AuthButton>
              <AuthButton type="button" onClick={retryAutoCheckout}>
                Try again
              </AuthButton>
            </>
          ) : undefined
        }
      >
        {redirectModal.variant === 'error' ? (
          <p className="text-sm text-warm-gray">
            {error ?? 'Something went wrong starting your checkout. Please try again.'}
          </p>
        ) : (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <div className="inline-block h-8 w-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
            <p className="text-sm text-warm-gray">{redirectCopy.body}</p>
          </div>
        )}
      </Modal>
    </AuthLayout>
  );
}
