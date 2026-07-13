import type { ReactNode } from 'react';

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Extra classes (e.g. `flex items-center gap-1.5` for a tab with a count). */
  className?: string;
}

/**
 * Underline-style tab button — the editor's canonical tab look (`border-b-2`,
 * active `text-coral border-coral`). Used by the rail detail headers and the
 * fares sub-editors. Callers own the row container and the active-state logic.
 */
export function TabButton({ active, onClick, children, className = '' }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 font-heading font-bold text-[13px] border-b-2 transition-colors ${
        active
          ? 'text-coral border-coral'
          : 'text-warm-gray border-transparent hover:text-dark-brown'
      } ${className}`}
    >
      {children}
    </button>
  );
}
