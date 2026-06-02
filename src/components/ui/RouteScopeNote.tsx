/**
 * Shown atop an analysis panel when some routes are hidden, so it's clear the
 * numbers reflect only the routes currently toggled on (scenario comparison).
 */
export function RouteScopeNote({ visible, total }: { visible: number; total: number }) {
  if (visible >= total) return null;
  return (
    <div className="mb-3 px-3 py-2 rounded-lg bg-coral-light border border-coral/30 text-[11px] text-dark-brown">
      Analyzing <strong>{visible}</strong> of {total} routes — the rest are hidden on the map.
      Toggle route visibility to compare scenarios.
    </div>
  );
}
