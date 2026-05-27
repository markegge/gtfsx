import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { useStore } from '../../store';
import { billingEnabled } from '../../utils/featureFlags';
import { fetchPlanCatalog, type PlanCatalogEntry, type Plan } from '../../services/billingApi';
import { trackCtaClick } from '../../services/trackBeacon';
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
    tagline: 'Edit and export feeds.',
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
    monthlyPriceUsd: 49,
    annualPriceUsd: 499,
    perSeat: false,
    tagline: 'Host and publish feeds.',
    features: [
      'Up to 10 saved feeds',
      'Publish 1 feed to a stable URL',
      'Rider-facing embeds + mini-site',
      'Submit to the Mobility Database',
      'Named snapshot history',
      'Custom brand color',
      'Email support (best-effort)',
    ],
  },
  {
    plan: 'team',
    displayName: 'Agency',
    monthlyPriceUsd: 299,
    annualPriceUsd: 2499,
    perSeat: false,
    tagline: 'Plan routes and service as a team.',
    features: [
      'Everything in Pro',
      'Unlimited saved feeds, publish up to 5',
      'Demographic coverage analysis',
      'Cost estimation analysis',
      'Title VI equity analysis',
      'Ridership propensity heatmap',
      'Unlimited team members in your organization',
      'Cross-org membership (work in unlimited client orgs)',
      'Custom org logo',
      'Email support (1-2 business day target)',
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
      'Unlimited Premium Feed Management',
      'Branded mini-sites',
      'Full Route Planning Features',
      'Phone + email support with SLA',
      'Contract terms via PO or invoice',
    ],
  },
];

const POPULAR_PLAN: Plan = 'team';
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
  const currentUser = useStore((s) => s.currentUser);
  // Each paid card has its own monthly/annual toggle so users can compare
  // (e.g. Pro monthly vs Agency annual) side-by-side without forcing both
  // into the same billing cadence. Keyed by plan id; defaults to monthly.
  const [intervals, setIntervals] = useState<Record<string, 'month' | 'year'>>({});
  const intervalFor = (plan: string): 'month' | 'year' => intervals[plan] ?? 'month';
  const setIntervalFor = (plan: string, i: 'month' | 'year') =>
    setIntervals((prev) => ({ ...prev, [plan]: i }));
  const [plans, setPlans] = useState<PlanCatalogEntry[]>(FALLBACK_PLANS);
  const [serverBillingEnabled, setServerBillingEnabled] = useState<boolean>(billingEnabled);
  const [talkToSalesOpen, setTalkToSalesOpen] = useState(false);

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

  function priceLabel(p: PlanCatalogEntry, interval: 'month' | 'year'): { amount: string; per: string } {
    const monthly = p.monthlyPriceUsd;
    const annual = p.annualPriceUsd;
    if (monthly === null || annual === null) return { amount: 'Custom', per: '' };
    if (interval === 'month') return { amount: `$${monthly}`, per: p.perSeat ? '/seat/mo' : '/mo' };
    return { amount: `$${annual.toLocaleString()}`, per: p.perSeat ? '/seat/yr' : '/yr' };
  }

  return (
    <AuthLayout title="Pricing" subtitle="The fast, free GTFS editor. Paid plans add Premium Feed Management and Route Planning Features." wide>
      <div className="space-y-8">
        <TestModeBanner />
        <div className="text-sm text-warm-gray">
          The editor and GTFS-Flex authoring are always free. Pro adds hosting and publishing; Agency adds the full route-planning suite.
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[free, ...selfServePlans, enterprise].map((p) => {
            const popular = p.plan === POPULAR_PLAN;
            const isFree = p.plan === 'free';
            const isEnterprise = p.plan === 'enterprise';
            // Toggle only shows on paid self-serve plans (both prices exist).
            const showToggle = !isFree && !isEnterprise && p.monthlyPriceUsd !== null && p.annualPriceUsd !== null;
            const cardInterval = intervalFor(p.plan);
            const label = priceLabel(p, cardInterval);
            return (
              <div
                key={p.plan}
                className={`relative flex flex-col rounded-2xl border bg-cream p-5 ${
                  popular ? 'border-coral shadow-lg' : 'border-sand'
                }`}
              >
                {popular && (
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
                  {/* Agency tier ships with a 14-day trial; show it inline so
                      the price doesn't look like a hard commitment. */}
                  {popular && (
                    <p className="mt-1 text-xs font-semibold text-coral">14-day free trial · cancel anytime</p>
                  )}
                  {/* Per-card monthly/annual toggle. Each paid card carries
                      its own toggle so users can compare e.g. Pro monthly vs
                      Agency annual side-by-side. Agency annual saves ~3.6
                      months vs monthly; Pro annual saves ~1.8. The exact
                      figure isn't shown here — it's visible in the price. */}
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
                  ) : (
                    <AuthButton
                      fullWidth
                      onClick={() => {
                        // Carry the per-card toggle through to the upgrade
                        // flow so the user lands on their chosen billing
                        // cadence (was previously a single shared interval).
                        const target = `/upgrade?plan=${p.plan}&interval=${cardInterval}`;
                        if (!currentUser) {
                          navigate(`/login?next=${encodeURIComponent(target)}`);
                          return;
                        }
                        navigate(target);
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
