import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { useStore } from '../../store';
import { PlanBadge } from './PlanBadge';
import { UsageMeter } from './UsageMeter';
import {
  fetchUserBilling,
  openBillingPortal,
  type OwnerBillingState,
} from '../../services/billingApi';
import { ApiError } from '../../services/authApi';
import { planDisplayName } from './planConfig';
import { TestModeBanner } from './TestModeBanner';

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const STATUS_COPY: Record<string, { label: string; variant: 'success' | 'warning' | 'error' | 'info' }> = {
  active: { label: 'Active', variant: 'success' },
  trialing: { label: 'Trial', variant: 'info' },
  past_due: { label: 'Payment failed — update card', variant: 'error' },
  canceled: { label: 'Canceled — ends at period close', variant: 'warning' },
};

export function AccountBillingPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);

  const [state, setState] = useState<OwnerBillingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  const checkoutFlag = searchParams.get('checkout');
  // Legacy ?upgrade=<plan> intent used to auto-open the in-page dialog. The
  // upgrade flow now lives on /pricing, so any caller passing the legacy
  // query gets redirected there.
  const legacyUpgradeIntent = searchParams.get('upgrade');

  // The post-checkout polling effect calls this with silent=true so the page
  // doesn't flash a "Loading…" placeholder every 2s while we wait for the
  // webhook to update the cached plan.
  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchUserBilling();
      setState(data);
      setError(null);
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unauthenticated') {
        navigate('/login?next=/account/billing');
        return null;
      }
      setError((e as Error)?.message ?? 'Could not load billing info.');
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  useEffect(() => {
    if (authChecked && currentUser) refresh();
  }, [authChecked, currentUser, refresh]);

  // Track whether we're waiting for the webhook to update the cached plan
  // after a successful checkout. Lets us show a single calm "Confirming…"
  // indicator instead of repeatedly toggling the full-page loading state.
  const [confirmingPlan, setConfirmingPlan] = useState(false);

  // Poll briefly after returning from a successful checkout so the cached plan
  // updates without forcing a manual refresh. Stops as soon as the plan
  // transitions away from 'free' (or after ~20s as a hard cap).
  useEffect(() => {
    if (checkoutFlag !== 'success') return;
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
      const fresh = await refresh(true);
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
    // We intentionally exclude `searchParams` / `setSearchParams` from the
    // dependency list — recomputing the effect every time we strip the query
    // param would tear down and restart the polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutFlag, refresh]);

  // Anything that used to deep-link to /account/billing?upgrade=<plan> now
  // gets bounced to the canonical /pricing page so the in-app modal is
  // truly retired. This preserves any back-compat links that may exist in
  // old emails or saved tabs.
  useEffect(() => {
    if (!legacyUpgradeIntent) return;
    const interval = searchParams.get('interval');
    const params = new URLSearchParams();
    params.set('plan', legacyUpgradeIntent);
    if (interval) params.set('interval', interval);
    navigate(`/pricing?${params.toString()}`, { replace: true });
  }, [legacyUpgradeIntent, searchParams, navigate]);

  async function handleManage() {
    if (!currentUser) return;
    setOpeningPortal(true);
    try {
      const result = await openBillingPortal({
        ownerType: 'user',
        ownerId: currentUser.id,
      });
      window.location.href = result.url;
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not open billing portal.');
      setOpeningPortal(false);
    }
  }

  if (!authChecked || loading) {
    return (
      <AuthLayout title="Billing" wide>
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!currentUser) {
    return (
      <AuthLayout title="Sign in required" wide>
        <Link to="/login" className="text-coral font-semibold hover:underline">
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Billing" subtitle="Manage your plan, seats, and invoices." wide>
      <div className="space-y-6">
        <TestModeBanner />
        {checkoutFlag === 'success' && (
          <div className="rounded-xl border border-teal bg-teal-light/40 p-4 text-sm text-teal flex items-center gap-3">
            {confirmingPlan && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-teal border-t-transparent" />
            )}
            <span>
              {confirmingPlan
                ? 'Thanks — Stripe confirms payment. Waiting for the subscription to activate…'
                : state
                  ? `You’re now on the ${planDisplayName(state.plan)} plan.`
                  : 'You’re now on your new plan.'}
            </span>
          </div>
        )}
        {checkoutFlag === 'canceled' && (
          <div className="rounded-xl border border-sand bg-cream p-4 text-sm text-warm-gray">
            Checkout was canceled. Nothing was charged.
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
                  {STATUS_COPY[state.planStatus] && (
                    <span className={`text-xs font-bold uppercase tracking-wide ${
                      STATUS_COPY[state.planStatus].variant === 'error'
                        ? 'text-red-600'
                        : STATUS_COPY[state.planStatus].variant === 'warning'
                          ? 'text-amber-700'
                          : 'text-warm-gray'
                    }`}>
                      {STATUS_COPY[state.planStatus].label}
                    </span>
                  )}
                </div>
                <div className="text-sm text-warm-gray">
                  {state.plan === 'free' && 'No subscription on file. Upgrade to publish feeds and unlock analysis.'}
                  {state.plan !== 'free' && state.planRenewalAt && (
                    <>Next renewal: <span className="font-semibold text-brown">{formatDate(state.planRenewalAt)}</span></>
                  )}
                  {state.plan === 'enterprise' && state.planExpiresAt && (
                    <> · Contract ends: <span className="font-semibold text-brown">{formatDate(state.planExpiresAt)}</span></>
                  )}
                </div>
                {state.planSeatCount > 1 && (
                  <div className="mt-1 text-sm text-warm-gray">
                    Seats: <span className="font-semibold text-brown">{state.planSeatCount}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {state.hasStripeCustomer ? (
                  <AuthButton
                    variant="secondary"
                    onClick={handleManage}
                    disabled={openingPortal}
                  >
                    {openingPortal ? 'Opening…' : 'Manage billing'}
                  </AuthButton>
                ) : null}
                {state.plan === 'free' && (
                  <AuthButton onClick={() => navigate('/pricing')}>
                    Upgrade
                  </AuthButton>
                )}
                {state.plan !== 'free' && state.plan !== 'enterprise' && (
                  <AuthButton variant="secondary" onClick={() => navigate('/pricing')}>
                    Change plan
                  </AuthButton>
                )}
              </div>
            </div>
          </section>
        )}

        {state && (
          <section className="rounded-2xl border border-sand bg-cream p-6">
            <h2 className="font-heading text-lg font-bold text-dark-brown">Personal workspace usage</h2>
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
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-warm-gray">Snapshots per feed (limit)</span>
                <span className="font-semibold text-brown">
                  {state.quotas.snapshotsPerProject.limit >= 9999 ? 'Unlimited' : state.quotas.snapshotsPerProject.limit.toLocaleString()}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-warm-gray">Feed state size cap</span>
                <span className="font-semibold text-brown">
                  {Math.round(state.quotas.blobBytes.limit / (1024 * 1024)).toLocaleString()} MB
                </span>
              </div>
            </div>
            <p className="mt-4 text-xs text-warm-gray">
              Org-owned feeds count against the org’s plan limits — see the relevant{' '}
              <Link to="/feeds" className="text-coral hover:underline">workspace billing page</Link>.
            </p>
          </section>
        )}
      </div>
    </AuthLayout>
  );
}
