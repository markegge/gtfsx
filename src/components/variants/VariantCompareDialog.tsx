import { useMemo } from 'react';
import { compareActiveToBaseline, activeVariant, baselineVariant } from '../../services/variants';
import type { FeedDiff, RouteChange } from '../../services/feedDiff';

interface Props {
  onClose: () => void;
}

function fmtHours(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}`;
}
function fmtInt(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`;
}
function fmtMoney(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** Colour a delta: service metrics teal when up; cost/fleet red when up. */
function deltaClass(n: number, costLike = false): string {
  if (Math.abs(n) < 1e-6 || n === 0) return 'text-warm-gray';
  const up = n > 0;
  if (costLike) return up ? 'text-red-600' : 'text-teal';
  return up ? 'text-teal' : 'text-red-600';
}

function KpiCard({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="flex-1 min-w-[7rem] rounded-lg bg-cream border border-sand px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-warm-gray font-semibold">{label}</div>
      <div className={`text-lg font-heading font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function RouteRow({ c }: { c: RouteChange }) {
  const tag = c.kind === 'added'
    ? { t: 'NEW', cls: 'bg-teal/15 text-teal' }
    : c.kind === 'removed'
      ? { t: 'REMOVED', cls: 'bg-red-100 text-red-600' }
      : { t: 'CHANGED', cls: 'bg-sand text-warm-gray' };
  const parts: string[] = [];
  if (c.tripsPerWeekDelta) parts.push(`${fmtInt(c.tripsPerWeekDelta)} trips/wk`);
  if (Math.abs(c.revHoursWeeklyDelta) >= 0.1) parts.push(`${fmtHours(c.revHoursWeeklyDelta)} rev-hr/wk`);
  if (c.peakVehiclesDelta) parts.push(`${fmtInt(c.peakVehiclesDelta)} veh`);
  if (Math.abs(c.annualCostDelta) >= 1) parts.push(`${fmtMoney(c.annualCostDelta)}/yr`);
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-sand">
      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${tag.cls}`}>{tag.t}</span>
      <span className="font-semibold text-dark-brown text-sm truncate max-w-[10rem]">{c.label}</span>
      <span className="flex-1" />
      <span className="text-xs text-warm-gray tabular-nums text-right">{parts.join(' · ') || 'no service change'}</span>
    </div>
  );
}

/**
 * A2c — baseline comparison. Loads the active variant vs baseline (via
 * diffFeedState / E1) and renders a KPI delta strip + a per-route changeset.
 * "What does this service change cost vs. today?"
 */
export function VariantCompareDialog({ onClose }: Props) {
  const av = activeVariant();
  const bv = baselineVariant();
  const diff: FeedDiff | null = useMemo(() => compareActiveToBaseline(), []);

  const onBaseline = av?.baseline ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-sand">
          <div>
            <h2 className="font-heading font-bold text-dark-brown text-lg">Compare to baseline</h2>
            <p className="text-xs text-warm-gray mt-0.5">
              {onBaseline
                ? 'You’re viewing the baseline — switch to a variant to see its impact.'
                : <>How <span className="font-semibold text-coral">{av?.name}</span> changes service vs. <span className="font-semibold">{bv?.name ?? 'baseline'}</span>.</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-warm-gray hover:text-dark-brown text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-5 pt-4">
          {!diff ? (
            <p className="text-sm text-warm-gray">No variants to compare.</p>
          ) : diff.identical ? (
            <div className="rounded-lg bg-cream border border-sand p-6 text-center text-sm text-warm-gray">
              No differences from the baseline yet. Edit this variant — add trips, change a route,
              re-time a pattern — then compare again.
            </div>
          ) : (
            <>
              {/* KPI delta strip */}
              <div className="flex flex-wrap gap-2 mb-4">
                <KpiCard label="Trips / week" value={fmtInt(diff.kpi.delta.tripsPerWeek)} cls={deltaClass(diff.kpi.delta.tripsPerWeek)} />
                <KpiCard label="Revenue hrs / wk" value={fmtHours(diff.kpi.delta.revenueHoursWeekly)} cls={deltaClass(diff.kpi.delta.revenueHoursWeekly)} />
                <KpiCard label="Peak vehicles" value={fmtInt(diff.kpi.delta.systemPeakVehicles)} cls={deltaClass(diff.kpi.delta.systemPeakVehicles, true)} />
                <KpiCard label="Cost / week" value={fmtMoney(diff.kpi.delta.weeklyCost)} cls={deltaClass(diff.kpi.delta.weeklyCost, true)} />
                <KpiCard label="Cost / year" value={fmtMoney(diff.kpi.delta.annualCost)} cls={deltaClass(diff.kpi.delta.annualCost, true)} />
              </div>

              {/* Entity summary */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-warm-gray mb-3">
                <span><b className="text-dark-brown">{fmtInt(diff.trips.delta)}</b> trips</span>
                {diff.routes.added > 0 && <span><b className="text-teal">+{diff.routes.added}</b> routes</span>}
                {diff.routes.removed > 0 && <span><b className="text-red-600">−{diff.routes.removed}</b> routes</span>}
                {diff.routes.changed > 0 && <span><b className="text-dark-brown">{diff.routes.changed}</b> routes changed</span>}
                {diff.stops.added + diff.stops.removed + diff.stops.changed > 0 &&
                  <span><b className="text-dark-brown">{diff.stops.added + diff.stops.removed + diff.stops.changed}</b> stop edits</span>}
                {diff.frequencies.added + diff.frequencies.removed + diff.frequencies.changed > 0 &&
                  <span><b className="text-dark-brown">{diff.frequencies.added + diff.frequencies.removed + diff.frequencies.changed}</b> frequency edits</span>}
                {diff.patterns.added + diff.patterns.removed > 0 &&
                  <span><b className="text-dark-brown">{diff.patterns.added + diff.patterns.removed}</b> pattern changes</span>}
              </div>

              {/* Per-route changeset */}
              {diff.routeChanges.length > 0 && (
                <div className="rounded-lg border border-sand overflow-hidden">
                  <div className="px-3 py-2 bg-cream text-[11px] font-bold uppercase tracking-wide text-warm-gray">
                    By route
                  </div>
                  {diff.routeChanges.map((c) => <RouteRow key={c.routeId} c={c} />)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t border-sand flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg font-heading font-bold text-sm bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
