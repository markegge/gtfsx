import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';

const SUPPORT_EMAIL = 'support@gtfsx.com';
const SUPPORT_PHONE = '(406) 548-4488';
const SUPPORT_PHONE_TEL = '+14065484488';

// Help landing page. Linked from the floating "?" button in the editor and
// from /docs footers. Surfaces three entry points (quick-start, full docs,
// forum) plus the support-contact info that the user's plan entitles them to.

export function HelpPage() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const userOrgs = useStore((s) => s.userOrgs);

  // Plan resolution. The user's personal plan covers Pro support; Agency
  // (internal id 'agency') and Enterprise live on the org subscription, so we
  // surface phone support if they belong to any agency/enterprise org (we
  // also check the user's plan in case enterprise was granted personally).
  const tier = useMemo<'agency' | 'pro' | 'free'>(() => {
    const userPlan = currentUser?.plan ?? 'free';
    if (userPlan === 'enterprise') return 'agency';
    const hasAgencyOrg = userOrgs.some(
      (o) => o.plan === 'agency' || o.plan === 'enterprise',
    );
    if (hasAgencyOrg) return 'agency';
    if (userPlan === 'pro' || userPlan === 'agency') return userPlan === 'agency' ? 'agency' : 'pro';
    return 'free';
  }, [currentUser, userOrgs]);

  return (
    <div className="min-h-screen bg-cream">
      <header className="sticky top-0 z-10 bg-white border-b border-sand h-14 flex items-center px-5 gap-4">
        <Link to="/" className="inline-flex items-center gap-2.5 shrink-0">
          <img src="/gtfsx-mark.svg" alt="" className="w-11 h-11 max-[720px]:w-9 max-[720px]:h-9" />
          <span className="font-extrabold text-2xl text-coral tracking-tight max-[720px]:text-xl">
            GTFS·X
          </span>
        </Link>
        <nav className="hidden min-[720px]:flex gap-1 ml-3">
          <a href="/about/" className="text-sm font-semibold px-3 py-2 rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream">About</a>
          <a href="/docs/" className="text-sm font-semibold px-3 py-2 rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream">Docs</a>
          <a href="/learn/gtfs/" className="text-sm font-semibold px-3 py-2 rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream">Learn</a>
          <a href="/docs/deep-links/" className="text-sm font-semibold px-3 py-2 rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream">Integrations</a>
          <Link to="/community" className="text-sm font-semibold px-3 py-2 rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream">Community</Link>
          <Link to="/help" className="text-sm font-semibold px-3 py-2 rounded-md text-dark-brown bg-cream">Help</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="hidden min-[720px]:inline-flex bg-coral text-white px-3.5 py-2 rounded-lg font-semibold text-sm hover:brightness-95 transition-[filter]"
          >
            Open editor
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-10">
        <h1 className="font-heading font-extrabold text-3xl text-dark-brown mb-2">Help &amp; support</h1>
        <p className="text-warm-gray mb-8">
          Pick the path that fits — guided self-serve, the full reference, the community, or a direct line to us.
        </p>

        <div className="grid gap-4 sm:grid-cols-3 mb-10">
          <HelpCard
            href="/docs/quick-start/"
            external
            badge="Start here"
            title="Quick start guide"
            body="A 7-step walkthrough — agency, calendars, routes, stops, timetables, fares, export. Get a working feed in under an hour."
          />
          <HelpCard
            href="/docs/"
            external
            badge="Reference"
            title="Full documentation"
            body="Every panel, edge case, and configuration option. Use this when you know what you're looking for."
          />
          <HelpCard
            href="/community"
            badge="Community"
            title="Community forum"
            body="Bug reports, feature requests, and Q&A. Search before you post — somebody may have already solved it."
          />
        </div>

        <section className="bg-white border border-sand rounded-2xl p-6 mb-10">
          <h2 className="font-heading font-bold text-xl text-dark-brown mb-1">Direct support</h2>
          {tier === 'agency' ? (
            <>
              <p className="text-sm text-warm-gray mb-4">
                Agency and Enterprise subscriptions include direct email and phone support.
              </p>
              <SupportRow
                label="Email"
                href={`mailto:${SUPPORT_EMAIL}`}
                value={SUPPORT_EMAIL}
              />
              <SupportRow
                label="Phone"
                href={`tel:${SUPPORT_PHONE_TEL}`}
                value={SUPPORT_PHONE}
                note="Business hours, Mountain time. Voicemail outside of those hours; we'll call back same-day."
              />
            </>
          ) : tier === 'pro' ? (
            <>
              <p className="text-sm text-warm-gray mb-4">
                Pro subscriptions include direct email support — typical response within 1&ndash;2 business days.
              </p>
              <SupportRow
                label="Email"
                href={`mailto:${SUPPORT_EMAIL}`}
                value={SUPPORT_EMAIL}
              />
              <p className="mt-4 text-sm text-warm-gray">
                Need a same-day response or a phone line? <Link to="/pricing" className="text-coral font-semibold underline hover:text-[#d4603a]">Agency plan</Link> adds phone support.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-warm-gray mb-4">
                Direct support is included with the Pro and Agency plans. On the free tier the community forum is the right place to ask.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/pricing"
                  className="px-4 py-2 rounded-lg bg-coral text-white font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
                >
                  See plans
                </Link>
                <Link
                  to="/community"
                  className="px-4 py-2 rounded-lg bg-sand text-brown font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
                >
                  Open the forum
                </Link>
              </div>
            </>
          )}
        </section>

        <section className="text-sm text-warm-gray">
          <h2 className="font-heading font-bold text-lg text-dark-brown mb-2">A few other useful pages</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li><a href="/learn/gtfs/" className="text-coral underline hover:text-[#d4603a]">What is GTFS?</a> — plain-English intro to the spec.</li>
            <li><a href="/learn/gtfs-flex/" className="text-coral underline hover:text-[#d4603a]">What is GTFS-Flex?</a> — demand-responsive transit in GTFS.</li>
            <li><a href="/docs/deep-links/" className="text-coral underline hover:text-[#d4603a]">Deep-link integration</a> — opening GTFS·X from your own tools.</li>
            <li><Link to="/pricing" className="text-coral underline hover:text-[#d4603a]">Pricing &amp; plans</Link>.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

function HelpCard({
  href,
  external,
  badge,
  title,
  body,
}: {
  href: string;
  external?: boolean;
  badge: string;
  title: string;
  body: string;
}) {
  const inner = (
    <div className="h-full bg-white border border-sand rounded-2xl p-5 hover:border-coral hover:shadow transition-all flex flex-col">
      <span className="self-start mb-2 inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-coral-light text-coral">
        {badge}
      </span>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-1">{title}</h3>
      <p className="text-sm text-warm-gray flex-1">{body}</p>
      <span className="mt-3 text-sm text-coral font-semibold">Open →</span>
    </div>
  );
  if (external) {
    return <a href={href}>{inner}</a>;
  }
  return <Link to={href}>{inner}</Link>;
}

function SupportRow({ label, value, href, note }: { label: string; value: string; href: string; note?: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">{label}</div>
      <a href={href} className="text-base text-coral font-semibold underline hover:text-[#d4603a]">
        {value}
      </a>
      {note && <div className="text-xs text-warm-gray mt-1">{note}</div>}
    </div>
  );
}
