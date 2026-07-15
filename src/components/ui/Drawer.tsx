import type { ReactNode } from 'react';
import { Button } from './Button';

interface DrawerProps {
  /** Icon glyph rendered in the coral/teal/gold chip. */
  icon: ReactNode;
  /** Tailwind classes for the icon chip background + text (e.g. "bg-coral-light text-coral"). */
  iconClassName: string;
  title: string;
  sub?: ReactNode;
  /** Live "Creates N trips" style count, shown teal at the footer's left. */
  count: ReactNode;
  applyLabel: string;
  canApply?: boolean;
  onApply: () => void;
  onCancel: () => void;
  /** The sentence-style form controls. */
  children: ReactNode;
}

/** One consistent inline home for the bulk trip tools (Generate / Set run time /
 *  Repeat). Sits between the toolbar and the grid: an icon chip, a title +
 *  teaching sub-line, a sentence-style form, and a footer with a live count plus
 *  Cancel / Apply. Replaces the old modal + inline-card mix. */
export function Drawer({
  icon,
  iconClassName,
  title,
  sub,
  count,
  applyLabel,
  canApply = true,
  onApply,
  onCancel,
  children,
}: DrawerProps) {
  return (
    <div role="region" aria-label={title} className="shrink-0 flex items-start gap-3.5 px-4 py-3.5 bg-cream border-b border-sand">
      <div
        className={`shrink-0 mt-0.5 w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-base ${iconClassName}`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-heading font-extrabold text-[14.5px] text-dark-brown">{title}</div>
        {sub && <div className="text-xs text-warm-gray mt-px">{sub}</div>}
        <div className="flex items-center gap-2 flex-wrap mt-2.5 text-xs text-brown">{children}</div>
        <div className="flex items-center gap-3 mt-3">
          <span className="font-heading font-extrabold text-[12.5px] text-teal mr-auto">{count}</span>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onApply} disabled={!canApply}>
            {applyLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
