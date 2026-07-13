import type { ReactNode } from 'react';

type BannerVariant = 'info' | 'promo' | 'alert' | 'warning';

interface BannerProps {
  /** info=teal, promo=coral, alert=red, warning=gold. Default info. */
  variant?: BannerVariant;
  children: ReactNode;
  /** Optional leading icon (emoji / small svg). */
  icon?: ReactNode;
  /** When present, render a × dismiss button that calls this. */
  onDismiss?: () => void;
  /** aria-label for the dismiss button. Default "Dismiss". */
  dismissLabel?: string;
  /** Optional action node (links/buttons) rendered before the dismiss button. */
  actions?: ReactNode;
  className?: string;
}

const variantStyles: Record<BannerVariant, { container: string; text: string }> = {
  info: { container: 'bg-teal-light border-sand', text: 'text-teal' },
  promo: { container: 'bg-coral-light border-sand', text: 'text-coral' },
  alert: { container: 'bg-red-50 border-red-200', text: 'text-red-700' },
  warning: { container: 'bg-gold-light border-amber-200', text: 'text-amber-700' },
};

/**
 * In-flow, full-width notification bar for the top of the editor (welcome,
 * partner-import, restored, locked, promo). Sits in the column flow with a
 * bottom border and `shrink-0` so it never collapses under the map.
 */
export function Banner({
  variant = 'info',
  children,
  icon,
  onDismiss,
  dismissLabel = 'Dismiss',
  actions,
  className = '',
}: BannerProps) {
  const styles = variantStyles[variant];
  return (
    <div
      className={`shrink-0 flex items-center gap-3 px-5 py-2 border-b ${styles.container} ${className}`}
    >
      {icon && <span aria-hidden>{icon}</span>}
      <span className={`flex-1 text-sm ${styles.text}`}>{children}</span>
      {actions}
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label={dismissLabel}
          className={`${styles.text} hover:opacity-70 text-lg leading-none px-2`}
        >
          ×
        </button>
      )}
    </div>
  );
}
