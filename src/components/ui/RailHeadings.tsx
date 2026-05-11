import type { ReactNode } from 'react';

/**
 * Three-tier text hierarchy for the right rail:
 *
 *   1. RailSectionTitle    — the rail header H2 ("Routes", "Agency").
 *      Lives inside RightRail.GenericHeader and RailEntityHeader.
 *   2. RailSubHeading       — H3 sub-section ("Identity", "Route Shapes").
 *      Used inside panel bodies. Optional pill-count.
 *   3. Eyebrow              — uppercase 11px form-field labels (existing
 *      Tailwind utility classes); reserved for *labels*, not headings.
 */

export function RailSubHeading({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <h3 className="font-heading font-extrabold text-[13px] tracking-[0.04em] uppercase text-dark-brown m-0">
        {children}
      </h3>
      {count != null && (
        <span className="font-body text-[11px] text-warm-gray bg-cream px-2 py-0.5 rounded-full">
          {count.toLocaleString()}
        </span>
      )}
      {action}
    </div>
  );
}

export function RailDivider() {
  return <div className="h-px bg-sand my-5" />;
}
