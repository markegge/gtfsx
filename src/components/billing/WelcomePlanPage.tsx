// Canonical tier-picker page. Reachable from:
//   - Post-signup-verify redirect (?source=welcome)
//   - Account billing / org billing "Upgrade" buttons
//   - Paywall overlays (?feature=<key>)
//   - The /pricing page CTAs for logged-in users
//   - The /upgrade alias
//
// Replaces the old in-app upgrade modal — picking a plan happens entirely on
// this page, and each card kicks off Stripe Checkout (or the org-create
// sub-step for Team) directly without an intermediate dialog.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { useStore } from '../../store';
import {
  fetchPlanCatalog,
  openBillingPortal,
  startCheckout,
  type PlanCatalogEntry,
  type Plan,
} from '../../services/billingApi';
import { createOrg, roleAtLeast, type OrgSummary } from '../../services/orgsApi';
import { ApiError } from '../../services/authApi';
import { billingEnabled } from '../../utils/featureFlags';
import { planDisplayName, cheapestPlanFor, FEATURE_COPY, type FeatureKey } from './planConfig';
import { TestModeBanner } from './TestModeBanner';

// Mirrors PricingPage's fallback list. Used when the worker is unreachable.
const FALLBACK_PLANS: PlanCatalogEntry[] = [
  {
    plan: 'free', displayName: 'Free', monthlyPriceUsd: 0, annualPriceUsd: 0, perSeat: false,
    tagline: 'Edit and export feeds.',
    features: ['Up to 3 saved feeds in the cloud', 'GTFS ZIP export (host anywhere)', 'Free forever', 'Community support'],
  },
  {
    plan: 'pro', displayName: 'Pro', monthlyPriceUsd: 49, annualPriceUsd: 499, perSeat: false,
    tagline: 'Host and publish feeds.',
    features: ['Up to 10 saved feeds', 'Publish 1 feed to a stable URL', 'Rider-facing embeds + mini-site', 'Submit to the Mobility Database', 'Named snapshot history', 'Custom brand color', 'Email support'],
  },
  {
    plan: 'team', displayName: 'Agency', monthlyPriceUsd: 299, annualPriceUsd: 2499, perSeat: false,
    tagline: 'Plan routes and service as a team.',
    features: ['Everything in Pro', 'Unlimited feeds', 'Demographic coverage analysis', 'Cost estimation analysis', 'Title VI equity analysis', 'Ridership propensity heatmap', 'Unlimited team members in your organization', 'Cross-org membership (work in unlimited client orgs)', 'Custom org logo', 'Email support'],
  },
  {
    plan: 'enterprise', displayName: 'Enterprise', monthlyPriceUsd: null, annualPriceUsd: null, perSeat: false,
    tagline: 'For state DOTs, RTAP networks, and large consortiums.',
    features: ['Custom feed and seat limits', 'Unlimited managed publishing', 'Branded mini-sites', 'Full analysis tools', 'Phone + email support with SLA', 'Contract terms via PO or invoice'],
  },
];

const ENTERPRISE_MAIL =
  'mailto:hello@gtfsx.com?subject=GTFS·X Enterprise inquiry&body=Hi%20—%20I%27d%20like%20to%20learn%20more%20about%20the%20Enterprise%20plan.';

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
  // Pad short names so the slug satisfies the 3-char minimum.
  return (cleaned || 'team') + '-org';
}

export function WelcomePlanPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const userOrgs = useStore((s) => s.userOrgs);
  const orgsLoaded = useStore((s) => s.orgsLoaded);
  const loadOrgs = useStore((s) => s.loadOrgs);
  const upsertUserOrg = useStore((s) => s.upsertUserOrg);

  const source = searchParams.get('source'); // 'welcome' = post-signup
  const featureParam = searchParams.get('feature') as FeatureKey | null;
  const presetOwnerType = searchParams.get('ownerType') as 'user' | 'org' | null;
  const presetOwnerId = searchParams.get('ownerId');
  // If the entry-point already picked a plan (e.g. /pricing card → /upgrade)
  // we auto-trigger that plan's checkout instead of making the user click
  // through the matrix a second time.
  const directPlanParam = searchParams.get('plan');
  const directIntervalParam = searchParams.get('interval') as 'month' | 'year' | null;

  const initialInterval: 'month' | 'year' = directIntervalParam === 'year' ? 'year' : 'month';
  const [interval, setInterval] = useState<'month' | 'year'>(initialInterval);
  const [plans, setPlans] = useState<PlanCatalogEntry[]>(FALLBACK_PLANS);
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Team-without-org sub-form state. Activated when user clicks "Choose Team"
  // and we have no admin org to attach the subscription to.
  const [teamOrgPrompt, setTeamOrgPrompt] = useState<null | { name: string; slug: string }>(null);

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
        // Keep fallback content.
      });
  }, []);

  const currentPlan: Plan = (currentUser?.plan as Plan | undefined) ?? 'free';
  const onPaidPlan = currentPlan !== 'free' && currentPlan !== 'enterprise';

  // Auto-pick after a deep-link from /pricing (e.g. /upgrade?plan=pro). Waits
  // for auth + orgs to load, fires once, and skips silently if the user is
  // already on the requested plan. Team still routes through the org picker /
  // create form via handlePick — we don't bypass that step.
  useEffect(() => {
    if (autoTriggered) return;
    if (!authChecked || !currentUser) return;
    if (!orgsLoaded) return;
    if (!directPlanParam) return;
    if (directPlanParam !== 'pro' && directPlanParam !== 'team') {
      setAutoTriggered(true);
      return;
    }
    if (currentPlan === directPlanParam) {
      setAutoTriggered(true);
      return;
    }
    setAutoTriggered(true);
    // handlePick is defined further down — capture the click via the same
    // dispatch so Team correctly funnels into the org-create flow.
    handlePick(directPlanParam as Plan);
    // We deliberately don't include handlePick in the deps — it's recreated
    // on every render but the auto-trigger guard ensures we only fire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTriggered, authChecked, currentUser, orgsLoaded, directPlanParam, currentPlan]);

  // Orgs the user can administer — eligible to host an Agency subscription.
  const adminOrgs: OrgSummary[] = useMemo(
    () => userOrgs.filter((o) => roleAtLeast(o.role, 'admin')),
    [userOrgs],
  );

  // If the caller specified an org owner (e.g. coming from /orgs/:slug/billing),
  // require Team checkout to target that org. Otherwise fall back to the
  // user's first admin org, or the org-create flow.
  const presetOrg = useMemo(() => {
    if (presetOwnerType !== 'org' || !presetOwnerId) return null;
    return adminOrgs.find((o) => o.id === presetOwnerId) ?? null;
  }, [presetOwnerType, presetOwnerId, adminOrgs]);

  const ordered = useMemo(() => {
    const order: Plan[] = ['free', 'pro', 'team', 'enterprise'];
    return order
      .map((p) => plans.find((c) => c.plan === p))
      .filter((c): c is PlanCatalogEntry => !!c);
  }, [plans]);

  function priceLabel(p: PlanCatalogEntry): { amount: string; per: string } {
    const monthly = p.monthlyPriceUsd;
    const annual = p.annualPriceUsd;
    if (monthly === null || annual === null) return { amount: 'Custom', per: '' };
    if (interval === 'month') return { amount: `$${monthly}`, per: p.perSeat ? '/seat/mo' : '/mo' };
    return { amount: `$${annual.toLocaleString()}`, per: p.perSeat ? '/seat/yr' : '/yr' };
  }

  // Kick off Stripe Checkout. The owner mapping is enforced server-side too,
  // but we resolve it here so the redirect happens in a single round-trip.
  async function startPaidCheckout(plan: 'pro' | 'team', orgId?: string) {
    if (!currentUser) {
      navigate('/login?next=/upgrade');
      return;
    }
    if (!billingEnabled) {
      setError('Billing is not yet enabled in this environment.');
      setPendingPlan(null);
      return;
    }
    setError(null);
    setPendingPlan(plan);
    try {
      const ownerType: 'user' | 'org' = plan === 'team' ? 'org' : 'user';
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

  // Top-level click handler for each tier card. Dispatches into the
  // free/enterprise/team/other-paid branches.
  async function handlePick(plan: Plan) {
    if (plan === 'free') {
      // "Switch to Free" from an active paid subscription is a
      // cancellation, not a navigation — Stripe owns subscription
      // lifecycle, so route through the Customer Portal where the user
      // can confirm and cancel. Decide which owner's portal to open based
      // on where the upgrade flow was launched: an org context (preset
      // from /orgs/:slug/billing) wins, otherwise fall through to the
      // user's personal subscription.
      let portalOwnerType: 'user' | 'org' | null = null;
      let portalOwnerId: string | null = null;
      if (
        presetOrg &&
        presetOrg.plan &&
        presetOrg.plan !== 'free' &&
        presetOrg.plan !== 'enterprise'
      ) {
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
      window.location.href = ENTERPRISE_MAIL;
      return;
    }
    if (plan === 'team') {
      // If the entry point pinned a specific org (org admins coming from
      // /orgs/:slug/billing), use that. Otherwise prefer the user's existing
      // admin org. If they have none, prompt for an org name.
      const orgId = presetOrg?.id ?? adminOrgs[0]?.id;
      if (orgId) {
        void startPaidCheckout('team', orgId);
      } else {
        const defaultName = `${currentUser?.displayName ?? 'My'} Transit`;
        setTeamOrgPrompt({ name: defaultName, slug: slugifyOrgName(defaultName) });
      }
      return;
    }
    void startPaidCheckout(plan as 'pro');
  }

  // Submit handler for the inline "Create your organization" form. Creates
  // the org first (plan='free' at this point — Stripe webhook will flip it
  // to 'team' after Checkout completes), then starts Team checkout against
  // the new org's ID.
  async function handleCreateOrgAndCheckout() {
    if (!teamOrgPrompt) return;
    const name = teamOrgPrompt.name.trim();
    const slug = slugifyOrgName(teamOrgPrompt.slug || name);
    if (!name) {
      setError('Organization name is required.');
      return;
    }
    setError(null);
    setPendingPlan('team');
    try {
      const res = await createOrg({ name, slug });
      // Surface the new org in the workspace switcher right away.
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
      await startPaidCheckout('team', res.organization.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Could not create organization.');
      setPendingPlan(null);
    }
  }

  if (!authChecked) {
    return (
      <AuthLayout title="Pick a plan" wide>
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!currentUser) {
    return (
      <AuthLayout title="Sign in required" wide>
        <p className="text-sm text-warm-gray mb-3">
          You need to be signed in to choose a plan.
        </p>
        <Link to="/login" className="text-coral font-semibold hover:underline">Sign in</Link>
      </AuthLayout>
    );
  }

  // Inline org-create sub-step for Team. Renders in place of the tier matrix
  // so the user has one focused thing to do.
  if (teamOrgPrompt) {
    return (
      <AuthLayout
        title="Name your organization"
        subtitle="Agency subscriptions are billed to an organization. We’ll create it now and route the subscription to it."
        wide={false}
      >
        <div className="space-y-4">
          <TestModeBanner />
          <FormField
            label="Organization name"
            value={teamOrgPrompt.name}
            onChange={(name) =>
              setTeamOrgPrompt({ name, slug: slugifyOrgName(name) })
            }
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
              disabled={pendingPlan === 'team'}
            >
              Back
            </AuthButton>
            <AuthButton
              onClick={handleCreateOrgAndCheckout}
              type="button"
              disabled={pendingPlan === 'team' || !teamOrgPrompt.name.trim()}
            >
              {pendingPlan === 'team' ? 'Creating…' : 'Continue to checkout'}
            </AuthButton>
          </div>
        </div>
      </AuthLayout>
    );
  }

  // Headline copy depends on context: post-signup welcome vs. an in-app
  // upgrade from a paywall or billing page.
  const isWelcome = source === 'welcome';
  const recommendedPlan = featureParam ? cheapestPlanFor(featureParam) : null;
  const headerSubtitle = (() => {
    if (featureParam && FEATURE_COPY[featureParam]) {
      return `Unlocks ${FEATURE_COPY[featureParam].title.toLowerCase()}: ${FEATURE_COPY[featureParam].description}`;
    }
    if (isWelcome) {
      return 'Your email is verified. Pick the plan that fits — you can always change later.';
    }
    if (onPaidPlan) {
      return `You're on ${planDisplayName(currentPlan)}. Compare tiers or change your plan below.`;
    }
    return 'Pick the plan that fits — you can always change later.';
  })();

  return (
    <AuthLayout
      title={isWelcome ? 'Welcome — pick your plan' : 'Choose your plan'}
      subtitle={headerSubtitle}
      wide
    >
      <div className="space-y-6">
        <TestModeBanner />
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm text-warm-gray">
            All paid plans include managed feed publishing, GTFS-Flex authoring, and the editor.
          </div>
          <div className="inline-flex rounded-full border border-sand bg-cream p-1 text-xs">
            {(['month', 'year'] as const).map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setInterval(i)}
                className={`rounded-full px-3 py-1.5 font-semibold transition-colors ${
                  interval === i ? 'bg-coral text-white' : 'text-warm-gray hover:text-brown'
                }`}
              >
                {i === 'month' ? 'Monthly' : 'Annual · save 2 months'}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ordered.map((p) => {
            const label = priceLabel(p);
            const isCurrent = p.plan === currentPlan;
            const isFree = p.plan === 'free';
            const isEnterprise = p.plan === 'enterprise';
            const popular = p.plan === 'team' && !recommendedPlan;
            const recommended = recommendedPlan === p.plan;
            const isPending = pendingPlan === p.plan;
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
                {isCurrent && (
                  <span className="absolute -top-3 left-4 rounded-full bg-teal px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Your plan
                  </span>
                )}
                {!isCurrent && recommended && (
                  <span className="absolute -top-3 left-4 rounded-full bg-purple px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Recommended
                  </span>
                )}
                {!isCurrent && !recommended && popular && (
                  <span className="absolute -top-3 left-4 rounded-full bg-coral px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Free trial
                  </span>
                )}
                <div>
                  <h3 className="font-heading text-lg font-bold text-dark-brown">{p.displayName}</h3>
                  <p className="mt-1 text-xs text-warm-gray">{p.tagline}</p>
                </div>
                <div className="mt-4">
                  <div className="flex items-baseline gap-1">
                    <span className="font-heading text-3xl font-extrabold text-brown">{label.amount}</span>
                    {label.per && <span className="text-xs text-warm-gray">{label.per}</span>}
                  </div>
                </div>
                <ul className="mt-4 space-y-2 text-sm text-brown flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-teal">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  {isCurrent ? (
                    <Link
                      to="/feeds"
                      className="block w-full rounded-lg bg-teal py-2.5 text-center font-heading text-sm font-bold text-white hover:bg-[#1f7e72]"
                    >
                      Continue to my feeds
                    </Link>
                  ) : isFree ? (
                    <AuthButton fullWidth variant="secondary" onClick={() => handlePick('free')}>
                      {isWelcome ? 'Continue with Free' : 'Switch to Free'}
                    </AuthButton>
                  ) : isEnterprise ? (
                    <a
                      href={ENTERPRISE_MAIL}
                      className="block w-full rounded-lg border border-sand bg-cream py-2.5 text-center font-heading text-sm font-bold text-brown hover:border-coral hover:text-coral"
                    >
                      Talk to sales
                    </a>
                  ) : (
                    <AuthButton
                      fullWidth
                      onClick={() => handlePick(p.plan)}
                      disabled={pendingPlan !== null}
                    >
                      {isPending ? 'Redirecting…' : `Choose ${p.displayName}`}
                    </AuthButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="text-center">
          <Link
            to={onPaidPlan ? '/account/billing' : '/feeds'}
            className="text-sm text-warm-gray hover:text-coral"
          >
            {onPaidPlan ? '← Back to billing settings' : 'Decide later — take me to the editor →'}
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}
