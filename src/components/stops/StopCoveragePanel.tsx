import { useEffect, useMemo, useRef, useState } from 'react';
import distance from '@turf/distance';
import { point } from '@turf/helpers';
import { useStore } from '../../store';
import { calculateCoverage, demographicShares, baselineShares } from '../../services/coverageAnalysis';
import { fetchCensusData, lookupFips, type BlockGroupData } from '../../services/demographics';
import { directionName } from '../../utils/constants';

// Module-level cache so navigating between stops in the same county doesn't
// re-fetch Census data. Keyed by `${stateFips}-${countyFips}`. Survives
// component unmounts but is wiped on page reload.
const blockGroupCache = new Map<string, BlockGroupData[]>();

/**
 * Per-stop Coverage subpanel.
 *
 * Two sections:
 *   1. Adjacency — for every (route, direction) the stop is on, show the
 *      previous and next stop in sequence with the great-circle distance
 *      to each. Stop names are click-through links that jump to that
 *      stop's edit panel.
 *   2. Demographic coverage — population, households, and workers within
 *      the buffer of THIS stop alone. Uses the same calculateCoverage
 *      helper the system Coverage panel uses, but with a 1-element stops
 *      array. Requires that `coverageData.blockGroups` already exists in
 *      the store (i.e. the user has run the system Coverage at least
 *      once); if not, surfaces a "Run Coverage first" prompt rather than
 *      forcing a fresh Census fetch from a stop subpanel.
 *
 * Buffer defaults to 1/4 mi to match CoveragePanel for non-tram routes; if
 * any route this stop is on is route_type 0 (tram / light rail), default to
 * 1/2 mi. User can toggle between 1/4 / 1/2.
 */
export function StopCoveragePanel() {
  const editingStopId = useStore((s) => s.editingStopId);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const coverageData = useStore((s) => s.coverageData);
  // Per-stop Census fetch. Reuses system Coverage's blockGroups when
  // present; otherwise looks up FIPS for THIS stop and fetches its county.
  // Cached at the module level so adjacent stops in the same county don't
  // re-fetch. Result lives in local state — we don't write to coverageData
  // because that holds the system-level analysis (systemResult,
  // routeResults, bufferGeoJSON) and partial population would break it.
  const [localBlockGroups, setLocalBlockGroups] = useState<BlockGroupData[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const lastFetchKey = useRef<string | null>(null);

  const stop = useMemo(
    () => stops.find((s) => s.stop_id === editingStopId) ?? null,
    [stops, editingStopId],
  );

  // Default buffer: 0.5 mi if any of the stop's routes is light rail
  // (route_type 0), else 0.25 mi — mirrors getBufferForRoute's logic
  // in services/coverageAnalysis.ts.
  const stopRoutes = useMemo(() => {
    if (!stop) return [] as Array<{ routeId: string; routeType: number }>;
    const ids = new Set(
      routeStops.filter((rs) => rs.stop_id === stop.stop_id).map((rs) => rs.route_id),
    );
    return [...ids].map((id) => {
      const r = routes.find((rr) => rr.route_id === id);
      return { routeId: id, routeType: r?.route_type ?? 3 };
    });
  }, [stop, routeStops, routes]);

  const defaultBuffer: 0.25 | 0.5 = stopRoutes.some((r) => r.routeType === 0) ? 0.5 : 0.25;
  const [bufferMiles, setBufferMiles] = useState<0.25 | 0.5>(defaultBuffer);

  // Adjacency rows: one per (route, direction) the stop is on.
  const adjacencyRows = useMemo(() => {
    if (!stop) return [] as Array<{
      routeId: string;
      directionId: 0 | 1;
      label: string;
      prev: { stop: typeof stops[number]; miles: number } | null;
      next: { stop: typeof stops[number]; miles: number } | null;
    }>;
    const out: Array<{
      routeId: string;
      directionId: 0 | 1;
      label: string;
      prev: { stop: typeof stops[number]; miles: number } | null;
      next: { stop: typeof stops[number]; miles: number } | null;
    }> = [];
    const stopPt = point([stop.stop_lon, stop.stop_lat]);
    const seen = new Set<string>();
    for (const rs of routeStops) {
      if (rs.stop_id !== stop.stop_id) continue;
      const key = `${rs.route_id}__${rs.direction_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ordered = routeStops
        .filter((r) => r.route_id === rs.route_id && r.direction_id === rs.direction_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      const idx = ordered.findIndex((r) => r.stop_id === stop.stop_id);
      const prevRs = idx > 0 ? ordered[idx - 1] : null;
      const nextRs = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;
      const route = routes.find((r) => r.route_id === rs.route_id);
      const name = route?.route_short_name || route?.route_long_name || rs.route_id;
      const label = `${name} — ${directionName(route, rs.direction_id)}`;
      const lookup = (sid: string) => stops.find((s) => s.stop_id === sid);
      const prev = (() => {
        if (!prevRs) return null;
        const ps = lookup(prevRs.stop_id);
        if (!ps) return null;
        const miles = distance(point([ps.stop_lon, ps.stop_lat]), stopPt, { units: 'miles' });
        return { stop: ps, miles };
      })();
      const next = (() => {
        if (!nextRs) return null;
        const ns = lookup(nextRs.stop_id);
        if (!ns) return null;
        const miles = distance(stopPt, point([ns.stop_lon, ns.stop_lat]), { units: 'miles' });
        return { stop: ns, miles };
      })();
      out.push({ routeId: rs.route_id, directionId: rs.direction_id, label, prev, next });
    }
    return out;
  }, [stop, routeStops, stops, routes]);

  // Resolved block groups — system Coverage's cache wins; otherwise the
  // per-stop fetch result.
  const blockGroups = coverageData?.blockGroups ?? localBlockGroups;

  // Fire a per-stop Census fetch when we need block groups and don't have
  // them yet. The ref-based dedup prevents the effect from re-firing on
  // setFetching(true) — which would otherwise cancel its own request via
  // the cleanup, leaving the spinner stuck.
  useEffect(() => {
    if (!stop) return;
    if (coverageData?.blockGroups) return;
    if (localBlockGroups) return;
    const key = stop.stop_id;
    if (lastFetchKey.current === key) return;
    lastFetchKey.current = key;

    (async () => {
      setFetchError(null);
      setFetching(true);
      try {
        const { stateFips, countyFips } = await lookupFips(stop.stop_lat, stop.stop_lon);
        const cacheKey = `${stateFips}-${countyFips}`;
        let bgs = blockGroupCache.get(cacheKey);
        if (!bgs) {
          bgs = await fetchCensusData(stateFips, countyFips);
          blockGroupCache.set(cacheKey, bgs);
        }
        // Re-read the latest stop from the store to defend against the
        // common case where the user navigated to a different stop while
        // the fetch was in flight — we want to keep the data only if it's
        // for the stop we started fetching for.
        if (lastFetchKey.current === key) setLocalBlockGroups(bgs);
      } catch (err) {
        if (lastFetchKey.current === key) {
          setFetchError(err instanceof Error ? err.message : 'Failed to fetch Census data');
        }
      } finally {
        if (lastFetchKey.current === key) setFetching(false);
      }
    })();
  }, [stop, coverageData, localBlockGroups]);

  const coverageResult = useMemo(() => {
    if (!stop || !blockGroups) return null;
    return calculateCoverage([stop], blockGroups, bufferMiles);
  }, [stop, blockGroups, bufferMiles]);

  // Equity shares for this stop's buffer vs. the county baseline.
  const shares = useMemo(
    () => (coverageResult ? demographicShares(coverageResult) : null),
    [coverageResult],
  );
  const baseline = useMemo(
    () => (blockGroups ? baselineShares(blockGroups) : null),
    [blockGroups],
  );

  if (!stop) return null;

  const fmtMiles = (m: number) => {
    if (m < 0.1) return `${(m * 5280).toFixed(0)} ft`;
    return `${m.toFixed(2)} mi`;
  };
  const fmtNum = (n: number) => n.toLocaleString();

  const jumpToStop = (stopId: string) => setEditingStopId(stopId);

  return (
    <div className="space-y-4">
      {/* ─── Adjacency ─── */}
      <div>
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          Distance to adjacent stops
        </label>
        {adjacencyRows.length === 0 ? (
          <p className="text-xs text-warm-gray italic">This stop isn't assigned to any route yet.</p>
        ) : (
          <div className="space-y-3">
            {adjacencyRows.map((row) => (
              <div key={`${row.routeId}__${row.directionId}`} className="bg-cream rounded-lg p-3">
                <p className="text-[11px] font-semibold text-dark-brown mb-2">{row.label}</p>
                <div className="text-xs space-y-1.5">
                  {row.prev ? (
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-warm-gray shrink-0">From</span>
                      <button
                        onClick={() => jumpToStop(row.prev!.stop.stop_id)}
                        className="text-coral hover:underline truncate text-left"
                        title={row.prev.stop.stop_name}
                      >
                        {row.prev.stop.stop_name || row.prev.stop.stop_id}
                      </button>
                      <span className="text-warm-gray ml-auto tabular-nums">{fmtMiles(row.prev.miles)}</span>
                    </div>
                  ) : (
                    <div className="text-warm-gray italic">First stop in direction</div>
                  )}
                  {row.next ? (
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-warm-gray shrink-0">To</span>
                      <button
                        onClick={() => jumpToStop(row.next!.stop.stop_id)}
                        className="text-coral hover:underline truncate text-left"
                        title={row.next.stop.stop_name}
                      >
                        {row.next.stop.stop_name || row.next.stop.stop_id}
                      </button>
                      <span className="text-warm-gray ml-auto tabular-nums">{fmtMiles(row.next.miles)}</span>
                    </div>
                  ) : (
                    <div className="text-warm-gray italic">Last stop in direction</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Demographic coverage ─── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
            Demographic coverage
          </label>
          <div className="inline-flex rounded-md border border-sand bg-cream p-0.5 text-[11px]">
            {[0.25, 0.5].map((b) => (
              <button
                key={b}
                onClick={() => setBufferMiles(b as 0.25 | 0.5)}
                className={`px-2 py-0.5 rounded font-semibold transition-colors ${
                  bufferMiles === b ? 'bg-coral text-white' : 'text-warm-gray hover:text-dark-brown'
                }`}
              >
                {b === 0.25 ? '1/4 mi' : '1/2 mi'}
              </button>
            ))}
          </div>
        </div>

        {fetching ? (
          <div className="bg-cream rounded-lg p-3 text-center">
            <div className="inline-block w-4 h-4 border-2 border-teal border-t-transparent rounded-full animate-spin mb-1" />
            <p className="text-xs text-warm-gray">Fetching Census data for this county…</p>
          </div>
        ) : fetchError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-xs text-red-700 font-medium">Couldn't load Census data</p>
            <p className="text-[11px] text-red-600 mt-0.5">{fetchError}</p>
          </div>
        ) : coverageResult ? (
          <div className="bg-cream rounded-lg p-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[10px] text-warm-gray uppercase tracking-wide mb-0.5">Population</div>
              <div className="text-sm font-heading font-bold text-dark-brown tabular-nums">
                {fmtNum(coverageResult.totalPopulation)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-warm-gray uppercase tracking-wide mb-0.5">Households</div>
              <div className="text-sm font-heading font-bold text-dark-brown tabular-nums">
                {fmtNum(coverageResult.totalHouseholds)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-warm-gray uppercase tracking-wide mb-0.5">Workers</div>
              <div className="text-sm font-heading font-bold text-dark-brown tabular-nums">
                {fmtNum(coverageResult.totalWorkers)}
              </div>
            </div>
          </div>
        ) : null}
        <p className="mt-1.5 text-[10px] text-warm-gray">
          Estimated reach within a {bufferMiles === 0.25 ? '1/4-mile' : '1/2-mile'} straight-line buffer of this stop. Block-group apportionment uses the same circle-overlap method as the system Coverage panel.
        </p>

        {shares && baseline && coverageResult && coverageResult.totalPopulation > 0 && (
          <div className="mt-3 border border-sand rounded-lg overflow-hidden">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-cream text-warm-gray uppercase tracking-wide">
                  <th className="px-2 py-1 text-left font-semibold">Group</th>
                  <th className="px-2 py-1 text-right font-semibold">Here</th>
                  <th className="px-2 py-1 text-right font-semibold">County</th>
                </tr>
              </thead>
              <tbody>
                {STOP_SHARE_ROWS.map(({ key, label }, i) => (
                  <tr key={key} className={i % 2 ? 'bg-cream/50' : ''}>
                    <td className="px-2 py-1 text-dark-brown">{label}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-dark-brown">{fmtShare(shares[key])}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-warm-gray">{fmtShare(baseline[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const STOP_SHARE_ROWS = [
  { key: 'minority', label: 'Minority' },
  { key: 'lowIncome', label: 'Low-income' },
  { key: 'zeroVehicle', label: 'Zero-vehicle HH' },
  { key: 'senior', label: 'Age 65+' },
  { key: 'youth', label: 'Age <18' },
] as const;

function fmtShare(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}
