import { Fragment, type ReactNode } from 'react';

export interface BreadcrumbItem {
  label: ReactNode;
  /** When present the segment is a clickable button; otherwise it's the current (bold) page. */
  onClick?: () => void;
  title?: string;
  /** Extra classes for the segment (e.g. `truncate`). */
  className?: string;
}

/**
 * Inline breadcrumb trail — `Ancestor › Ancestor › Current`. Clickable segments
 * (those with `onClick`) render as coral-hover buttons; the trailing current
 * page (no `onClick`) renders bold. Renders inline so it drops into the
 * caller's own text-sized container and inherits the surrounding type scale.
 */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="opacity-50 mx-1.5">›</span>}
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              title={item.title}
              className={`hover:text-coral transition-colors ${item.className ?? ''}`}
            >
              {item.label}
            </button>
          ) : (
            <span className={`text-dark-brown font-semibold ${item.className ?? ''}`}>
              {item.label}
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}
