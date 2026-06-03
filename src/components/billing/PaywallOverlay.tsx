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
    // The card renders in normal flow so the wrapper hugs its content — no fixed
    // `min-h`/`h-full`, which used to leave a tall washed-out empty block below
    // the card in content-driven panels (the Costs/Coverage right rail). In
    // `preview` mode the gated content is painted as a faded backdrop behind the
    // card, clipped to the card's height.
    <div className={`relative overflow-hidden ${className}`}>
      {preview && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 select-none overflow-hidden opacity-40 blur-[1.5px]"
        >
          {children}
        </div>
      )}
      <div className="relative flex items-start justify-center bg-cream/85 backdrop-blur-sm">
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
