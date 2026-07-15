import type { ReactNode } from 'react';

// Re-exported from the shared UI primitive so admin pages keep importing
// `ConfirmDialog` from here; the API is unchanged.
export { ConfirmDialog } from '../ui/ConfirmDialog';

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    active: 'bg-teal-light text-teal',
    pending_verification: 'bg-gold-light text-amber-700',
    disabled: 'bg-sand text-warm-gray',
    deleted_soft: 'bg-red-100 text-red-700',
  };
  const cls = tone[status] ?? 'bg-sand text-warm-gray';
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
      {children}
    </div>
  );
}
