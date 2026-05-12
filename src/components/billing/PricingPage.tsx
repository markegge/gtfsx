import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { useStore } from '../../store';
import { billingEnabled } from '../../utils/featureFlags';
import { fetchPlanCatalog, type PlanCatalogEntry, type Plan } from '../../services/billingApi';
import { TestModeBanner } from './TestModeBanner';

// Fallback catalog used when the worker is unreachable (e.g. /pricing rendered
// before backend is enabled). Kept in sync with worker/billing/plans.ts.
const FALLBACK_PLANS: PlanCatalogEntry[] = [
  {
    plan: 'free',
    displayName: 'Free',
    monthlyPriceUsd: 0,
    annualPriceUsd: 0,
    perSeat: false,
    tagline: 'Build and self-host GTFS feeds at no cost.',
    features: [
      'Up to 3 saved feeds in the cloud',
      'GTFS ZIP export (host anywhere)',
      'Free forever',
      'Community support',
    ],
  },
  {
    plan: 'pro',
    displayName: 'Pro',
    monthlyPriceUsd: 19,
    annualPriceUsd: 190,
    perSeat: false,
    tagline: 'For individual operators and consultants.',
    features: [
      'Up to 10 saved feeds',
      'Publish 1 feed to a stable URL',
      'Rider-facing embeds + mini-site',
      'Demographic coverage analysis',
      'Cost estimation analysis',
      'Custom brand color',
      'Email support (best-effort)',
    ],
  },
  {
    plan: 'team',
    displayName: 'Team',
    monthlyPriceUsd: 199,
    annualPriceUsd: 1990,
    perSeat: false,
    tagline: 'For transit agencies with multiple staff.',
    features: [
      'Unlimited saved feeds',
      'Publish up to 5 feeds',
      'Full analysis: Title VI + propensity heatmap',
      'Team workspace (up to 10 seats)',
      'Custom brand color + org logo',
      'Email support (1-2 business day target)',
    ],
  },
  {
    plan: 'consultant',
    displayName: 'Consultant',
    monthlyPriceUsd: 79,
    annualPriceUsd: 790,
    perSeat: true,
    tagline: 'For consultants serving multiple agencies. Start solo, add seats later.',
    features: [
      'Cross-org membership (unlimited client orgs)',
      'Unlimited saved feeds',
      'Publish up to 5 feeds per seat',
      'Full analysis tools',
      'Add more seats from your billing settings as your firm grows',
      'Email support',
    ],
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
      'Unlimited managed publishing',
      'Branded mini-sites',
      'Full analysis tools',
      'Phone + email support with SLA',
      'Contract terms via PO or invoice',
    ],
  },
];

const POPULAR_PLAN: Plan = 'team';
const ENTERPRISE_MAIL =
  'mailto:sales@gtfsbuilder.net?subject=GTFS Builder Enterprise inquiry&body=Hi%20—%20I%27d%20like%20to%20learn%20more%20about%20the%20Enterprise%20plan.';

export function PricingPage() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [plans, setPlans] = useState<PlanCatalogEntry[]>(FALLBACK_PLANS);
  const [serverBillingEnabled, setServerBillingEnabled] = useState<boolean>(billingEnabled);

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

  const selfServePlans = useMemo(
    () => plans.filter((p) => p.plan !== 'free' && p.plan !== 'enterprise'),
    [plans],
  );
  const free = plans.find((p) => p.plan === 'free') ?? FALLBACK_PLANS[0];
  const enterprise = plans.find((p) => p.plan === 'enterprise') ?? FALLBACK_PLANS.at(-1)!;

  function priceLabel(p: PlanCatalogEntry): { amount: string; per: string } {
    const monthly = p.monthlyPriceUsd;
    const annual = p.annualPriceUsd;
    if (monthly === null || annual === null) return { amount: 'Custom', per: '' };
    if (interval === 'month') return { amount: `$${monthly}`, per: p.perSeat ? '/seat/mo' : '/mo' };
    return { amount: `$${annual.toLocaleString()}`, per: p.perSeat ? '/seat/yr' : '/yr' };
  }

  return (
    <AuthLayout title="Pricing" subtitle="Build feeds free. Publish to a stable URL when you’re ready." wide>
      <div className="space-y-8">
        <TestModeBanner />
        <div className="flex items-center justify-between gap-4">
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

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[free, ...selfServePlans, enterprise].map((p) => {
            const label = priceLabel(p);
            const popular = p.plan === POPULAR_PLAN;
            const isFree = p.plan === 'free';
            const isEnterprise = p.plan === 'enterprise';
            return (
              <div
                key={p.plan}
                className={`relative flex flex-col rounded-2xl border bg-cream p-5 ${
                  popular ? 'border-coral shadow-lg' : 'border-sand'
                }`}
              >
                {popular && (
                  <span className="absolute -top-3 left-4 rounded-full bg-coral px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Most popular
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
                  {isFree ? (
                    currentUser ? (
                      <Link
                        to="/feeds"
                        className="block w-full rounded-lg bg-sand py-2.5 text-center font-heading text-sm font-bold text-brown hover:bg-coral-light hover:text-coral"
                      >
                        Open my feeds
                      </Link>
                    ) : (
                      <Link
                        to="/signup"
                        className="block w-full rounded-lg bg-sand py-2.5 text-center font-heading text-sm font-bold text-brown hover:bg-coral-light hover:text-coral"
                      >
                        Create free account
                      </Link>
                    )
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
                      onClick={() => {
                        if (!currentUser) {
                          navigate(`/login?next=${encodeURIComponent(`/upgrade?plan=${p.plan}&interval=${interval}`)}`);
                          return;
                        }
                        navigate(`/upgrade?plan=${p.plan}&interval=${interval}`);
                      }}
                    >
                      {currentUser ? `Upgrade to ${p.displayName}` : `Start with ${p.displayName}`}
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
              <p className="font-semibold">What does “managed publishing” mean?</p>
              <p className="text-warm-gray">
                We host your feed at <code>feeds.gtfsbuilder.net/&lt;slug&gt;/gtfs.zip</code> — a stable
                URL you can hand to the Mobility Database, riders, or regulators. We also generate a
                rider-facing mini-site and embed widgets you can drop on your own website.
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
      </div>
    </AuthLayout>
  );
}
