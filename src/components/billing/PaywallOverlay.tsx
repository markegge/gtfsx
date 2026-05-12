import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { planHasFeature, FEATURE_COPY, planDisplayName, cheapestPlanFor, type FeatureKey } from './planConfig';
import { AuthButton } from '../auth/AuthButton';
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
}

export function PaywallOverlay({
  feature,
  currentPlan,
  children,
  preview = true,
  title,
  description,
  className = '',
}: PaywallOverlayProps) {
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();

  const hasAccess = planHasFeature(currentPlan, feature);
  if (hasAccess) {
    return <>{children}</>;
  }

  const copy = FEATURE_COPY[feature];
  const target = cheapestPlanFor(feature);
  const cta = currentUser ? 'Upgrade plan' : 'Sign in to upgrade';

  // Both CTAs route to the tier-picker page. Anonymous users get bounced
  // through login first; the page itself handles that case.
  const upgradeHref = currentUser
    ? `/upgrade?feature=${encodeURIComponent(feature)}`
    : `/login?next=${encodeURIComponent(`/upgrade?feature=${feature}`)}`;

  return (
    <div className={`relative ${className}`}>
      {preview && (
        <div aria-hidden className="pointer-events-none select-none opacity-40 blur-[1.5px]">
          {children}
        </div>
      )}
      <div
        className={`${
          preview ? 'absolute inset-0' : 'relative'
        } flex items-center justify-center bg-cream/85 backdrop-blur-sm`}
      >
        <div className="m-6 max-w-md rounded-2xl border border-sand bg-cream p-6 shadow-lg">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-coral">
            {planDisplayName(target)} plan
          </div>
          <h3 className="font-heading text-lg font-bold text-dark-brown">
            {title ?? copy.title}
          </h3>
          <p className="mt-1.5 text-sm text-warm-gray">
            {description ?? copy.description}
          </p>
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
