import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../../store';
import { compareVariants, variantFeedState } from '../../services/variants';
import {
  getVariantSpatialMetrics,
  peekVariantSpatialMetrics,
  type SpatialInput,
  type SpatialMetrics,
} from '../../services/variantSpatialMetrics';
import type { FeedDiff } from '../../services/feedDiff';

interface Props {
  onClose: () => void;
}

/* ──────────────────────────── formatting ──────────────────────────── */

/** Signed, 1-dp hours for a delta cell. */
function dHours(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}`;
}
/** Signed integer for a delta cell. */
function dInt(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString()}`;
}
/** Signed compact money for a delta cell. */
function dMoney(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** Absolute (unsigned) formatters for the A / B value columns. */
function aHours(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString();
}
function aInt(n: number): string {
  return Math.round(n).toLocaleString();
}
function aMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(abs)}`;
}

/** Colour a delta: "more service / people / coverage" reads teal (good) when up;
 *  cost & fleet read red when up. Zero is neutral grey. */
function deltaClass(n: number, costLike = false): string {
  if (Math.abs(n) < 1e-6 || n === 0) return 'text-warm-gray';
  const up = n > 0;
  if (costLike) return up ? 'text-red-600' : 'text-teal';
  return up ? 'text-teal' : 'text-red-600';
}

/* ──────────────────────────── metric rows ──────────────────────────── */

type Fmt = 'hours' | 'money' | 'int';

interface MetricRow {
  label: string;
  a: number;
  b: number;
  fmt: Fmt;
  /** cost/fleet metrics colour red when they go UP; everything else teal-up. */
  costLike?: boolean;
  /** A modelled union, not an ACS count — badged "est." like CoveragePanel. */
  estimate?: boolean;
  /** Indented sub-row (the Title VI segments under Transit need, etc.). */
  sub?: boolean;
  /** Optional ⓘ tooltip. */
  info?: string;
}

function absFmt(n: number, fmt: Fmt): string {
  return fmt === 'hours' ? aHours(n) : fmt === 'money' ? aMoney(n) : aInt(n);
}
function deltaFmt(n: number, fmt: Fmt): string {
  return fmt === 'hours' ? dHours(n) : fmt === 'money' ? dMoney(n) : dInt(n);
}

function MetricRowView({ r }: { r: MetricRow }) {
  const delta = r.b - r.a;
  return (
    <tr className={r.sub ? '' : 'border-t border-sand'}>
      <td className={`px-3 py-1.5 text-dark-brown ${r.sub ? 'pl-6 text-warm-gray' : 'font-medium'}`}>
        <span className="inline-flex items-center gap-1">
          {r.label}
          {r.estimate && (
            <span className="rounded border border-amber-300 bg-amber-50 px-1 text-[9px] font-bold uppercase tracking-wide text-amber-700">
              est.
            </span>
          )}
          {r.info && (
            <span title={r.info} aria-label={r.info} role="img" className="text-warm-gray/80 hover:text-teal cursor-help leading-none">
              ⓘ
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-warm-gray">{absFmt(r.a, r.fmt)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-dark-brown font-semibold">{absFmt(r.b, r.fmt)}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${deltaClass(delta, r.costLike)}`}>
        {deltaFmt(delta, r.fmt)}
      </td>
    </tr>
  );
}

/* ──────────────────────────── spatial async state ──────────────────────────── */

type SpatialState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; metrics: SpatialMetrics }
  | { status: 'unavailable'; message: string };

/** Turn a compute error into a short, honest line for the modal. */
function spatialErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // The region gate + empty-stop guard already say something readable; a fetch /
  // schema failure does not, so give it a generic-but-true line.
  if (/United States|No stops/i.test(msg)) return msg;
  return 'Coverage & demographics need the US census-block layer, which is unavailable for this feed right now.';
}

/**
 * A variant's spatial metrics, preferring the session cache (instant, no
 * spinner) and only showing "loading" on a real miss. Reads the variant's stop
 * set via variantFeedState (live for the active variant). A `cancelled` flag
 * keeps a stale async result from overwriting a newer pick.
 */
function useSpatialMetrics(variantId: string): SpatialState {
  const [state, setState] = useState<SpatialState>({ status: 'idle' });

  useEffect(() => {
    const feed = variantFeedState(variantId);
    if (!feed) {
      setState({ status: 'idle' });
      return;
    }
    const input: SpatialInput = { stops: feed.stops, routes: feed.routes, routeStops: feed.routeStops };

    // Cache hit → render instantly, no spinner (the "second open is instant"
    // requirement). Peek recomputes the fingerprint, so an edit to the active
    // variant's stops since the entry was cached correctly falls through to the
    // recompute below.
    const cached = peekVariantSpatialMetrics(variantId, input);
    if (cached) {
      setState({ status: 'ready', metrics: cached });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });
    getVariantSpatialMetrics(variantId, input)
      .then((metrics) => {
        if (!cancelled) setState({ status: 'ready', metrics });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'unavailable', message: spatialErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [variantId]);

  return state;
}

/* ──────────────────────────── the dialog ──────────────────────────── */

/**
 * A2c — variant comparison. Two pickers (A vs B; default A = baseline, B = the
 * active variant, which reproduces the old "compare to baseline" view exactly),
 * a side-by-side metric table with per-metric deltas (B − A), and the per-route
 * changeset underneath.
 *
 * Two kinds of metric:
 *  - Operational (revenue hours / cost / peak vehicles) — pure, from the cost
 *    engine via compareVariants → FeedDiff. Recomputed synchronously on a pick.
 *  - Spatial (demographics / coverage / equity) — tabulated from the exact
 *    census-block layer over each variant's walksheds, so they hit the network
 *    and are cached per variant (variantSpatialMetrics.ts). Each side shows a
 *    computing spinner on a cache miss and renders instantly on a hit.
 */
export function VariantCompareDialog({ onClose }: Props) {
  const variants = useStore((s) => s.variants);
  const activeVariantId = useStore((s) => s.activeVariantId);

  const baselineId = variants.find((v) => v.baseline)?.id ?? variants[0]?.id ?? '';
  const defaultBId = activeVariantId ?? baselineId;

  const [aId, setAId] = useState(baselineId);
  const [bId, setBId] = useState(defaultBId);

  const diff: FeedDiff | null = useMemo(
    () => (aId && bId ? compareVariants(aId, bId) : null),
    [aId, bId],
  );

  const spatialA = useSpatialMetrics(aId);
  const spatialB = useSpatialMetrics(bId);

  const aName = variants.find((v) => v.id === aId)?.name ?? 'A';
  const bName = variants.find((v) => v.id === bId)?.name ?? 'B';
  const sameVariant = aId === bId;

  // Operational rows (always available — pure in-memory computation).
  const opRows: MetricRow[] = diff
    ? [
        { label: 'Revenue hours / wk', a: diff.kpi.a.totalRevenueHoursWeekly, b: diff.kpi.b.totalRevenueHoursWeekly, fmt: 'hours' },
        { label: 'Operating cost / yr', a: diff.kpi.a.totalAnnualCost, b: diff.kpi.b.totalAnnualCost, fmt: 'money', costLike: true },
        {
          label: 'Peak vehicles',
          a: diff.kpi.a.systemPeakVehicles,
          b: diff.kpi.b.systemPeakVehicles,
          fmt: 'int',
          costLike: true,
          info: 'Vehicles required at the single busiest instant across the whole system (frequency-aware).',
        },
      ]
    : [];

  // Spatial rows, only when BOTH sides have a ready bundle (so a delta exists).
  const spatialReady =
    spatialA.status === 'ready' && spatialB.status === 'ready'
      ? { a: spatialA.metrics, b: spatialB.metrics }
      : null;
  const spatialRows: MetricRow[] = spatialReady
    ? [
        { label: 'Residents served', a: spatialReady.a.population, b: spatialReady.b.population, fmt: 'int', info: 'Residents in the census blocks within a walk of any stop (exact block-level ACS count, union — each block counted once).' },
        { label: 'Households served', a: spatialReady.a.households, b: spatialReady.b.households, fmt: 'int', sub: true },
        { label: 'Jobs served', a: spatialReady.a.jobs, b: spatialReady.b.jobs, fmt: 'int', sub: true, info: 'Jobs at the WORKPLACE (LODES) inside the walkshed. A different universe from residents — never add the two.' },
        { label: 'Census blocks covered', a: spatialReady.a.blocksCovered, b: spatialReady.b.blocksCovered, fmt: 'int', info: 'Distinct census blocks reachable from any stop — the spatial reach of the network.' },
        { label: 'Transit need served', a: spatialReady.a.needAll, b: spatialReady.b.needAll, fmt: 'int', estimate: true, info: 'ESTIMATE, not a count. De-duplicated union of carless, low-income, senior and disabled residents. Not a ridership forecast.' },
        { label: 'Carless residents', a: spatialReady.a.carless, b: spatialReady.b.carless, fmt: 'int', sub: true },
        { label: 'Low-income residents', a: spatialReady.a.lowIncome, b: spatialReady.b.lowIncome, fmt: 'int', sub: true },
        { label: 'Residents 65+', a: spatialReady.a.seniors, b: spatialReady.b.seniors, fmt: 'int', sub: true },
        { label: 'Residents with a disability', a: spatialReady.a.disability, b: spatialReady.b.disability, fmt: 'int', sub: true },
      ]
    : [];

  const spatialLoading = spatialA.status === 'loading' || spatialB.status === 'loading';
  const spatialUnavailable =
    spatialA.status === 'unavailable'
      ? spatialA.message
      : spatialB.status === 'unavailable'
        ? spatialB.message
        : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-sand">
          <div>
            <h2 className="font-heading font-bold text-dark-brown text-lg">Compare variants</h2>
            <p className="text-xs text-warm-gray mt-0.5">
              Service, cost and who each variant reaches. Deltas are <span className="font-semibold">B − A</span>.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-warm-gray hover:text-dark-brown text-xl leading-none">×</button>
        </div>

        {/* A / B pickers */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-sand bg-cream/50">
          <VariantPicker label="A" side="a" value={aId} variants={variants} onChange={setAId} />
          <span className="text-warm-gray text-sm font-bold">vs</span>
          <VariantPicker label="B" side="b" value={bId} variants={variants} onChange={setBId} />
        </div>

        <div className="overflow-y-auto p-5 pt-4">
          {!diff ? (
            <p className="text-sm text-warm-gray">No variants to compare.</p>
          ) : (
            <>
              {sameVariant && (
                <div className="mb-4 rounded-lg bg-cream border border-sand p-3 text-center text-xs text-warm-gray">
                  A and B are the same variant — pick two different variants to see a difference.
                </div>
              )}

              {/* Metric table */}
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] border-collapse min-w-[420px]">
                  <thead>
                    <tr className="bg-cream text-warm-gray uppercase tracking-wide text-[11px]">
                      <th className="px-3 py-1.5 text-left font-semibold">Metric</th>
                      <th className="px-3 py-1.5 text-right font-semibold max-w-[8rem] truncate" title={aName}>A · {aName}</th>
                      <th className="px-3 py-1.5 text-right font-semibold max-w-[8rem] truncate" title={bName}>B · {bName}</th>
                      <th className="px-3 py-1.5 text-right font-semibold">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <SectionHeader>Service &amp; cost</SectionHeader>
                    {opRows.map((r) => <MetricRowView key={r.label} r={r} />)}

                    <SectionHeader>Coverage &amp; demographics</SectionHeader>
                    {spatialRows.length > 0 ? (
                      spatialRows.map((r) => <MetricRowView key={r.label} r={r} />)
                    ) : (
                      <tr className="border-t border-sand">
                        <td colSpan={4} className="px-3 py-3">
                          {spatialLoading ? (
                            <span className="inline-flex items-center gap-2 text-xs text-warm-gray">
                              <span className="inline-block w-3.5 h-3.5 border-2 border-teal border-t-transparent rounded-full animate-spin" />
                              Computing coverage from the census-block layer…
                            </span>
                          ) : spatialUnavailable ? (
                            <span className="text-xs text-amber-700">{spatialUnavailable}</span>
                          ) : (
                            <span className="text-xs text-warm-gray">Coverage unavailable.</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Estimate + overlap note, mirroring CoveragePanel's vocabulary. */}
              {spatialRows.length > 0 && (
                <p className="text-[10px] text-warm-gray leading-relaxed mt-2">
                  <span className="font-semibold text-dark-brown">Transit need</span> is an{' '}
                  <span className="font-semibold">estimate, not a count</span> — a de-duplicated union of
                  the four segments below it, so a carless low-income resident is counted once. The
                  segments overlap; never add them. Residence-based counts and workplace{' '}
                  <span className="font-semibold text-dark-brown">Jobs</span> are different universes.
                  Exact census-block tabulation over each variant's stop walksheds.
                </p>
              )}

              {/* Entity summary */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-warm-gray mt-4 mb-3">
                {diff.trips.delta !== 0 && <span><b className="text-dark-brown">{dInt(diff.trips.delta)}</b> trips</span>}
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

              {/* Comparison stays at the topline metric level — no per-route
                  breakdown (removed per owner request). */}
              {!sameVariant && diff.identical && (
                <div className="rounded-lg bg-cream border border-sand p-4 text-center text-xs text-warm-gray">
                  No service differences between these two variants.
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

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <tr className="bg-cream/60 border-t border-sand">
      <td colSpan={4} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-warm-gray">
        {children}
      </td>
    </tr>
  );
}

function VariantPicker({
  label,
  side,
  value,
  variants,
  onChange,
}: {
  label: string;
  side: 'a' | 'b';
  value: string;
  variants: { id: string; name: string; baseline: boolean }[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 flex-1 min-w-0">
      <span
        className={`shrink-0 w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold ${
          side === 'a' ? 'bg-sand text-warm-gray' : 'bg-coral/15 text-coral'
        }`}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 rounded-lg border border-sand bg-white px-2 py-1.5 text-sm text-dark-brown focus:border-coral focus:outline-none"
      >
        {variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}{v.baseline ? ' (baseline)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
