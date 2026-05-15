import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { useStore } from '../../store';
import { PlanBadge } from './PlanBadge';
import { UsageMeter } from './UsageMeter';
import {
  fetchOrgBilling,
  openBillingPortal,
  type OrgBillingState,
} from '../../services/billingApi';
import { roleAtLeast } from '../../services/orgsApi';
import { ApiError } from '../../services/authApi';
import { billingEnabled } from '../../utils/featureFlags';
import { TestModeBanner } from './TestModeBanner';

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function OrgBillingPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const userOrgs = useStore((s) => s.userOrgs);
  const orgsLoaded = useStore((s) => s.orgsLoaded);
  const loadOrgs = useStore((s) => s.loadOrgs);

  const [state, setState] = useState<OrgBillingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  const checkoutFlag = searchParams.get('checkout');

  const matchingOrg = useMemo(
    () => userOrgs.find((o) => o.slug === slug) ?? null,
    [userOrgs, slug],
  );

  const isAdmin = matchingOrg ? roleAtLeast(matchingOrg.role, 'admin') : false;

  const refresh = useCallback(async () => {
    if (!matchingOrg) return null;
    try {
      const data = await fetchOrgBilling(matchingOrg.id);
      setState(data);
      setError(null);
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unauthenticated') {
        navigate(`/login?next=/orgs/${slug ?? ''}/billing`);
        return null;
      }
      setError((e as Error)?.message ?? 'Could not load org billing.');
      return null;
    }
  }, [matchingOrg, navigate, slug]);

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  useEffect(() => {
    if (authChecked && currentUser && !orgsLoaded) loadOrgs();
  }, [authChecked, currentUser, orgsLoaded, loadOrgs]);

  useEffect(() => {
    // refresh is async; setState happens after `await fetchOrgBilling`, but
    // the react-hooks rule flags any call into a function it has reasoned to
    // contain setState. Same pattern as AccountBillingPage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (orgsLoaded && matchingOrg) void refresh();
  }, [orgsLoaded, matchingOrg, refresh]);

  // After a successful checkout, poll for the webhook-driven plan update.
  // Stops as soon as the org's plan transitions away from 'free' (or after
  // ~20s as a hard cap). Mirrors the pattern on AccountBillingPage.
  const [confirmingPlan, setConfirmingPlan] = useState(false);
  useEffect(() => {
    if (checkoutFlag !== 'success') return;
    if (!matchingOrg) return;
    setConfirmingPlan(true);
    let attempts = 0;
    let cancelled = false;
    const clearIntent = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('checkout');
      next.delete('session_id');
      setSearchParams(next, { replace: true });
    };
    const id = window.setInterval(async () => {
      if (cancelled) return;
      attempts += 1;
      const fresh = await refresh();
      const settled = fresh && fresh.plan !== 'free';
      if (settled || attempts >= 10) {
        window.clearInterval(id);
        setConfirmingPlan(false);
        clearIntent();
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutFlag, matchingOrg, refresh]);

  async function handleManage() {
    if (!matchingOrg) return;
    setOpeningPortal(true);
    try {
      const result = await openBillingPortal({
        ownerType: 'org',
        ownerId: matchingOrg.id,
      });
      window.location.href = result.url;
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not open billing portal.');
      setOpeningPortal(false);
    }
  }

  if (!authChecked || (currentUser && !orgsLoaded)) {
    return (
      <AuthLayout title="Org billing" wide>
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }
  if (!currentUser) {
    return (
      <AuthLayout title="Sign in required" wide>
        <Link to="/login" className="text-coral font-semibold hover:underline">Sign in</Link>
      </AuthLayout>
    );
  }
  if (!matchingOrg) {
    return (
      <AuthLayout title="Organization not found" wide>
        <p className="text-sm text-warm-gray">
          You’re not a member of <code>{slug}</code>, or it no longer exists.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={`${matchingOrg.name} — Billing`}
      subtitle="Manage plan, seats, and invoices for this organization."
      wide
    >
      <div className="space-y-6">
        <TestModeBanner />
        <div className="flex items-center justify-between">
          <Link to={`/orgs/${matchingOrg.slug}`} className="text-sm text-warm-gray hover:text-coral">
            ← Back to organization
          </Link>
        </div>

        {checkoutFlag === 'success' && (
          <div className="rounded-xl border border-teal bg-teal-light/40 p-4 text-sm text-teal flex items-center gap-3">
            {confirmingPlan && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-teal border-t-transparent" />
            )}
            <span>
              {confirmingPlan
                ? 'Thanks — Stripe confirms payment. Waiting for the subscription to activate…'
                : `Your organization is now on ${state?.plan ?? 'its new'} plan.`}
            </span>
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        {state && (
          <section className="rounded-2xl border border-sand bg-cream p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <PlanBadge plan={state.plan} size="md" />
                  <span className="text-xs font-bold uppercase tracking-wide text-warm-gray">{state.planStatus}</span>
                </div>
                <div className="text-sm text-warm-gray">
                  {state.plan === 'free' && 'No subscription on file — upgrade to invite teammates and publish feeds.'}
                  {state.plan !== 'free' && state.planRenewalAt && (
                    <>Next renewal: <span className="font-semibold text-brown">{formatDate(state.planRenewalAt)}</span></>
                  )}
                  {state.plan === 'enterprise' && state.planExpiresAt && (
                    <> · Contract ends: <span className="font-semibold text-brown">{formatDate(state.planExpiresAt)}</span></>
                  )}
                </div>
                <div className="mt-1 text-sm text-warm-gray">
                  Seats: <span className="font-semibold text-brown">
                    {state.plan === 'team' || state.plan === 'enterprise'
                      ? `${state.quotas.seats.used} (unlimited)`
                      : `${state.quotas.seats.used} / ${state.planSeatCount}`}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {state.hasStripeCustomer && isAdmin && (
                  <AuthButton
                    variant="secondary"
                    onClick={handleManage}
                    disabled={openingPortal || !billingEnabled}
                  >
                    {openingPortal ? 'Opening…' : 'Manage billing'}
                  </AuthButton>
                )}
                {isAdmin && state.plan === 'free' && matchingOrg && (
                  <AuthButton
                    onClick={() => navigate(`/upgrade?ownerType=org&ownerId=${matchingOrg.id}`)}
                    disabled={!billingEnabled}
                  >
                    Upgrade to Team
                  </AuthButton>
                )}
              </div>
            </div>
            {!isAdmin && (
              <p className="mt-3 text-xs text-warm-gray">
                Only owners and admins can change the org’s plan or open the billing portal.
              </p>
            )}
            {!billingEnabled && (
              <p className="mt-3 text-xs text-amber-700">
                Billing actions are temporarily disabled in this environment.
              </p>
            )}
          </section>
        )}

        {state && (
          <section className="rounded-2xl border border-sand bg-cream p-6">
            <h2 className="font-heading text-lg font-bold text-dark-brown">Workspace usage</h2>
            <div className="mt-4 space-y-3">
              <UsageMeter
                label="Saved feeds"
                used={state.quotas.projects.used}
                limit={state.quotas.projects.limit}
                unbounded={state.quotas.projects.limit >= 9999}
              />
              <UsageMeter
                label="Published feeds"
                used={state.quotas.publishedFeeds.used}
                limit={state.quotas.publishedFeeds.limit}
                unbounded={state.quotas.publishedFeeds.limit >= 9999}
              />
              <UsageMeter
                label="Seats"
                used={state.quotas.seats.used}
                limit={state.quotas.seats.limit}
                unbounded={state.quotas.seats.limit >= 9999}
              />
            </div>
          </section>
        )}
      </div>
    </AuthLayout>
  );
}
