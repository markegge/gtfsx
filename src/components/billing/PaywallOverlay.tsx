import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { planHasFeature, FEATURE_COPY, planDisplayName, cheapestPlanFor, type FeatureKey } from './planConfig';
import { AuthButton } from '../auth/AuthButton';
import { trackPaywallView } from '../../services/trackBeacon';
import type { Plan } from '../../services/billingApi';

interface PaywallOverlayProps {
  feature: FeatureKey;
  /** Plan of the relevant owner (user or project owner). */
  currentPlan: Plan | undefined | null;
  /** UI region being gated. */
  children: ReactNode;
  /** When true, render the gated content underneath the overlay (faded). */
  preview?: boolean;
  /** Override the default title (defaults to FEATURE_COPY[feature].title). */
  title?: string;
  /** Override the description. */
  description?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
  /** Optional "see a live example" link in the overlay card (e.g. the embeds
   *  gate links free users to the public demo mini-site). */
  exampleHref?: string;
  exampleLabel?: string;
}

export function PaywallOverlay({
  feature,
  currentPlan,
  children,
  preview = true,
  title,
  description,
  className = '',
  exampleHref,
  exampleLabel,
}: PaywallOverlayProps) {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();

  const hasAccess = planHasFeature(currentPlan, feature);

  // Record a paywall view whenever the overlay is shown for a feature the
  // current plan can't access. Keyed on feature so switching gated panels
  // (e.g. Costs → Title VI) counts as distinct views; best-effort, no PII.
  useEffect(() => {
    if (!hasAccess) trackPaywallView(feature);
  }, [hasAccess, feature]);

  if (hasAccess) {
    return <>{children}</>;
  }

  const copy = FEATURE_COPY[feature];
  const target = cheapestPlanFor(feature);
  const cta = currentUser ? 'Upgrade plan' : 'Sign up to upgrade';

  // Both CTAs route to /pricing. Anonymous users go to sign-up first (carrying
  // the feature through), then land back on /pricing for checkout.
  const upgradeHref = currentUser
    ? `/pricing?feature=${encodeURIComponent(feature)}`
    : `/signup?next=${encodeURIComponent(`/pricing?feature=${feature}`)}`;

  return (
    // `min-h-[420px]` keeps room for the card even when the wrapped child
    // collapses to an empty state (Coverage/Title VI's "no data yet"); `h-full`
    // still claims the parent's full height when one is defined (Costs panel,
    // bottom-panel publish/embed) so the wash + card stay anchored at the top.
    <div className={`relative h-full min-h-[420px] overflow-hidden ${className}`}>
      {preview && (
        <div aria-hidden className="pointer-events-none select-none opacity-40 blur-[1.5px] h-full overflow-hidden">
          {children}
        </div>
      )}
      <div
        className={`${
          preview ? 'absolute inset-0' : 'relative'
        } flex items-start justify-center bg-cream/85 backdrop-blur-sm overflow-y-auto`}
      >
        <div className="m-6 max-w-md rounded-2xl border border-sand bg-white p-6 shadow-lg">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-coral">
            {planDisplayName(target)} plan
          </div>
          <h3 className="font-heading text-lg font-bold text-dark-brown">
            {title ?? copy.title}
          </h3>
          <p className="mt-1.5 text-sm text-warm-gray">
            {description ?? copy.description}
          </p>
          {exampleHref && (
            <a
              href={exampleHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm font-semibold text-coral hover:underline"
            >
              {exampleLabel ?? 'See a live example'} →
            </a>
          )}
          <div className="mt-4 flex gap-2">
            <AuthButton onClick={() => navigate(upgradeHref)}>{cta}</AuthButton>
            <AuthButton variant="ghost" onClick={() => navigate('/pricing')}>
              Compare plans
            </AuthButton>
          </div>
        </div>
      </div>
    </div>
  );
}
