import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import Papa from 'papaparse';
import { useStore } from '../../store';
import type { Route } from '../../types/gtfs';
import { EmptyState } from '../ui/EmptyState';
import { useVisibleFeed } from '../../hooks/useVisibleFeed';
import { RouteScopeNote } from '../ui/RouteScopeNote';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature, cheapestPlanFor, planDisplayName } from '../billing/planConfig';
import { downloadBlob } from '../../services/gtfsExport';
import { fetchCensusData, lookupFips } from '../../services/demographics';
import type { CoverageData } from '../../store/coverageSlice';
import {
  getBufferForRoute,
  generateBufferGeoJSON,
  coverageFromFractions,
  demographicShares,
  baselineShares,
  type CoverageResult,
  type DemographicShares,
} from '../../services/coverageAnalysis';
import {
  buildNetworkWalkshed,
  coverageFromWalkshed,
  walkshedGeoJSON,
  autoMinutesByStop,
  WALK_MODE_OPTIONS,
  AUTO_FREQUENT_MINUTES,
  AUTO_INFREQUENT_MINUTES,
  FREQUENT_HEADWAY_MAX_MIN,
  type WalkMode,
} from '../../services/networkWalkshed';
import {
  regionForState,
  bboxFromStops,
  loadBlocksInBbox,
  unionWalkshedPolygons,
  tabulateBlocks,
  type BlockCoverageResult,
} from '../../services/blockCoverage';
import { WalkshedProfilePanel } from './WalkshedProfilePanel';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Prose for the intro line describing the walkshed area for the chosen mode. */
function walkAreaDescription(mode: WalkMode): string {
  return mode === 'auto'
    ? `walk along the street network sized per stop — ${AUTO_FREQUENT_MINUTES}-min (≈½ mi) at ` +
        `frequent stops, ${AUTO_INFREQUENT_MINUTES}-min (≈¼ mi) elsewhere`
    : `${mode}-minute walk along the street network`;
}

/** Short badge for a per-route row given the walkshed mode used. */
function walkBadgeLabel(
  walkshed: { mode: 'buffer' } | { mode: 'network'; auto: boolean; minutes: number | null } | undefined,
): string | null {
  if (walkshed?.mode !== 'network') return null;
  return walkshed.auto ? 'auto walk' : `${walkshed.minutes} min walk`;
}

/** Buffer/walk label for one route result. Walk label wins in network mode. */
function bufferLabel(bufferMiles: number, walkLabel: string | null): string {
  if (walkLabel != null) return walkLabel;
  return bufferMiles === 0.5 ? '1/2 mi' : '1/4 mi';
}

/** System-level walkshed descriptor for the CSV "buffer" column. */
function systemBufferLabel(walkshed: CoverageData['walkshed']): string {
  if (walkshed?.mode === 'network') {
    return walkshed.auto ? 'auto walk network' : `${walkshed.minutes}-min walk network`;
  }
  return '1/4-1/2 mi buffer';
}

/** Equity share for a CSV cell: percent to 1 dp, blank when no data. */
function pctCsv(v: number | null): string {
  return v == null ? '' : (v * 100).toFixed(1);
}

/** True when a coverage result came from the EXACT census-block layer, which is
 *  the only source of jobs and of the two union estimates. */
function isBlockResult(r: CoverageResult | BlockCoverageResult): r is BlockCoverageResult {
  return 'totalJobs' in r;
}

/** One CSV row from a coverage result (system or per-route). Accepts an exact
 *  block-level result (adds jobs, the two union estimates and a block tally) or a
 *  block-group estimate; the `geography` column records which method produced the
 *  row.
 *
 *  The union columns are named `_ESTIMATE` and are left BLANK — never zero — for
 *  a block-group row. A zero would read as "nobody", when the truth is "this
 *  method cannot answer that question"; and a spreadsheet has no tooltip to
 *  explain the difference. */
function csvRow(
  scope: string,
  routeId: string,
  buffer: string,
  result: CoverageResult | BlockCoverageResult,
): Record<string, string | number> {
  const s = demographicShares(result);
  const block = isBlockResult(result) ? result : null;
  return {
    scope,
    route_id: routeId,
    geography: block ? 'block (exact)' : 'block group (estimate)',
    buffer,
    units_covered: block ? block.blocksCovered : result.coveredBlockGroupIds.length,
    population: result.totalPopulation,
    households: result.totalHouseholds,
    workers: result.totalWorkers,
    jobs: block ? block.totalJobs : '',
    ridership_propensity_ESTIMATE: block ? block.propensityAll : '',
    transit_need_ESTIMATE: block ? block.needAll : '',
    minority_pct: pctCsv(s.minority),
    low_income_pct: pctCsv(s.lowIncome),
    zero_vehicle_hh_pct: pctCsv(s.zeroVehicle),
    senior_pct: pctCsv(s.senior),
    youth_pct: pctCsv(s.youth),
  };
}

/**
 * Build the Coverage CSV: a System row, a County-baseline row, then one row per
 * route. Per-route rows are the Agency-gated breakdown, so they're only emitted
 * when `includePerRoute` is true (free users still get System + County).
 */
function buildCoverageCsvRows(
  data: CoverageData,
  routes: Route[],
  includePerRoute: boolean,
): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];

  // System + per-route rows use the EXACT block tabulation when available
  // (block-level regions), else the block-group estimate.
  rows.push(csvRow('System', '', systemBufferLabel(data.walkshed), data.blockResult ?? data.systemResult));

  // County baseline: whole-county totals + unweighted baseline shares, the
  // denominator the on-screen equity ratios compare against. Always the
  // block-group estimate (occupied households, to match the System row's
  // households definition), so it carries no union estimate — that number only
  // exists in the exact block layer.
  const county = data.blockGroups.reduce(
    (a, bg) => {
      a.population += bg.population;
      a.households += bg.occupiedHouseholds;
      a.workers += bg.workers;
      return a;
    },
    { population: 0, households: 0, workers: 0 },
  );
  const base = baselineShares(data.blockGroups);
  rows.push({
    scope: 'County baseline',
    route_id: '',
    geography: 'block group (county)',
    buffer: 'whole county',
    units_covered: data.blockGroups.length,
    population: county.population,
    households: county.households,
    workers: county.workers,
    jobs: '',
    ridership_propensity_ESTIMATE: '',
    transit_need_ESTIMATE: '',
    minority_pct: pctCsv(base.minority),
    low_income_pct: pctCsv(base.lowIncome),
    zero_vehicle_hh_pct: pctCsv(base.zeroVehicle),
    senior_pct: pctCsv(base.senior),
    youth_pct: pctCsv(base.youth),
  });

  if (includePerRoute) {
    const walkLabel = walkBadgeLabel(data.walkshed);
    for (const { routeId, result } of data.routeResults) {
      const route = routes.find((r) => r.route_id === routeId);
      const name = route ? route.route_short_name || route.route_long_name : routeId;
      const r = data.routeBlockResults?.find((x) => x.routeId === routeId)?.result ?? result;
      rows.push(csvRow(name, routeId, bufferLabel(result.bufferMiles, walkLabel), r));
    }
  }

  return rows;
}

function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  downloadBlob(new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8;' }), filename);
}

function CsvButton({ onClick, label = 'Download CSV' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="text-[11px] font-semibold text-teal hover:underline whitespace-nowrap">
      ↓ {label}
    </button>
  );
}

export function CoveragePanel() {
  // Analysis is scoped to the routes toggled visible on the map.
  const { stops, routes, visibleRouteCount, totalRouteCount } = useVisibleFeed();
  // System summary + demographic profile are free; per-route coverage is Agency+.
  const plan = useEditorPlan();
  const coverageData = useStore((s) => s.coverageData);
  const isFetchingCoverage = useStore((s) => s.isFetchingCoverage);
  const coverageError = useStore((s) => s.coverageError);
  const setCoverageData = useStore((s) => s.setCoverageData);
  const setIsFetchingCoverage = useStore((s) => s.setIsFetchingCoverage);
  const setCoverageError = useStore((s) => s.setCoverageError);

  // Network walksheds (street distance) — a paid-tier capability. Free users
  // keep the straight-line buffer; the toggle is disabled + paywalled for them.
  const canUseWalksheds = planHasFeature(plan, 'network_walksheds');
  const [useNetworkWalksheds, setUseNetworkWalksheds] = useState(false);
  // Walk-time mode. Default 'auto': each stop's walk-time is driven by its own
  // service frequency (10-min / ½-mi when frequent, else 5-min / ¼-mi). The
  // fixed 5/10/15 options apply one walk-time uniformly.
  const [walkMode, setWalkMode] = useState<WalkMode>('auto');
  // Non-blocking notice when the walkshed run fell back to the straight-line
  // buffer (API error / over the request cap). Cleared on each analysis.
  const [walkshedNotice, setWalkshedNotice] = useState<string | null>(null);

  const handleAnalyze = useCallback(async () => {
    if (stops.length === 0) return;

    setIsFetchingCoverage(true);
    setCoverageError(null);
    setWalkshedNotice(null);

    // Network walksheds are gated; never run them for a plan without access even
    // if the toggle somehow got set (server still enforces the real gate).
    const networkMode = useNetworkWalksheds && canUseWalksheds;

    try {
      // Compute centroid of all stops
      const avgLat = stops.reduce((sum, s) => sum + s.stop_lat, 0) / stops.length;
      const avgLon = stops.reduce((sum, s) => sum + s.stop_lon, 0) / stops.length;

      // Look up FIPS codes
      const { stateFips, countyFips } = await lookupFips(avgLat, avgLon);

      // Fetch Census block group data
      const blockGroups = await fetchCensusData(stateFips, countyFips);

      // Get the full store state for headway calculations
      const state = useStore.getState();

      // Auto mode: resolve each stop's walk-time from its own service frequency
      // (10 min when frequent ≤15-min headway, else 5 min). A fixed mode applies
      // one walk-time to every stop. The resolver is fed to buildNetworkWalkshed
      // so each stop's isochrone is the right size.
      const autoMinutes = networkMode && walkMode === 'auto' ? autoMinutesByStop(state) : null;
      const minutesResolver =
        walkMode === 'auto'
          ? (stop: { stop_id: string }) => autoMinutes!.get(stop.stop_id) ?? AUTO_INFREQUENT_MINUTES
          : (walkMode as number);

      // If network mode is requested, try to build the per-route + system
      // walkshed polygons up front. On any error / over-cap we flip back to the
      // straight-line buffer for the WHOLE analysis and surface a notice, so the
      // numbers and the map always agree on which geometry was used.
      let walkshedByRoute: Map<string, GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null> | null = null;
      if (networkMode) {
        walkshedByRoute = new Map();
        for (const route of routes) {
          const routeStopIds = new Set(
            state.routeStops.filter((rs) => rs.route_id === route.route_id).map((rs) => rs.stop_id),
          );
          const routeStops = state.stops.filter((s) => routeStopIds.has(s.stop_id));
          const res = await buildNetworkWalkshed(routeStops, minutesResolver);
          if (res.status === 'capped' || res.status === 'error') {
            setWalkshedNotice(res.message ?? 'Network walksheds unavailable — using straight-line buffer.');
            walkshedByRoute = null; // fall back entirely
            break;
          }
          walkshedByRoute.set(route.route_id, res.polygon);
        }
      }

      // Per-route coverage. Network mode apportions against the route's walkshed
      // polygon; otherwise the straight-line per-route buffer (0.5mi light rail,
      // 0.25mi else). Both feed the SAME coverageFromFractions summation.
      const routeResults = routes.map((route) => {
        if (walkshedByRoute) {
          const poly = walkshedByRoute.get(route.route_id);
          const bufferMiles = route.route_type === 0 ? 0.5 : 0.25;
          if (poly) {
            return { routeId: route.route_id, result: coverageFromWalkshed(poly, blockGroups, bufferMiles) };
          }
          // No reachable area for this route's stops → empty result.
          return {
            routeId: route.route_id,
            result: coverageFromFractions(new Map<string, number>(), blockGroups, bufferMiles),
          };
        }
        return {
          routeId: route.route_id,
          result: getBufferForRoute(route.route_id, state, blockGroups),
        };
      });

      // System summary: for each block group, take the max apportionment
      // fraction across all routes, then sum apportioned counts via the shared
      // helper so every demographic field aggregates identically to per-route.
      const systemFractions = new Map<string, number>();
      for (const { result } of routeResults) {
        for (const [geoid, f] of result.fractions) {
          if ((systemFractions.get(geoid) ?? 0) < f) systemFractions.set(geoid, f);
        }
      }
      const systemResult = coverageFromFractions(systemFractions, blockGroups, 0.25);

      // GeoJSON for map display — walkshed polygons in network mode, else the
      // per-route straight-line buffers.
      const allFeatures: GeoJSON.Feature[] = [];
      for (const { routeId, result } of routeResults) {
        const route = state.routes.find((r) => r.route_id === routeId);
        const color = route ? `#${route.route_color}` : '#888888';
        if (walkshedByRoute) {
          allFeatures.push(...walkshedGeoJSON(walkshedByRoute.get(routeId) ?? null, color, routeId));
        } else {
          const routeStopIds = new Set(
            state.routeStops.filter((rs) => rs.route_id === routeId).map((rs) => rs.stop_id),
          );
          const routeStops = state.stops.filter((s) => routeStopIds.has(s.stop_id));
          const bufferGeo = generateBufferGeoJSON(routeStops, result.bufferMiles);
          for (const feat of bufferGeo.features) {
            feat.properties = { ...feat.properties, route_id: routeId, route_color: color };
            allFeatures.push(feat);
          }
        }
      }

      const bufferGeoJSON: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: allFeatures,
      };

      // Block-level (US: 50 states + DC): tabulate EXACT census blocks whose
      // centroid falls inside the system walkshed (union of the per-route
      // buffers / isochrones). Best-effort: any failure (layer not deployed in
      // local dev, fetch/parse error) silently falls back to the block-group
      // estimate so the panel still renders normally.
      let blockResult: BlockCoverageResult | undefined;
      let routeBlockResults: { routeId: string; result: BlockCoverageResult }[] | undefined;
      const region = regionForState(stateFips);
      if (region) {
        try {
          const bbox = bboxFromStops(stops);
          if (bbox) {
            const blocks = await loadBlocksInBbox(region, bbox);
            const walkshedPoly = unionWalkshedPolygons(allFeatures);
            blockResult = tabulateBlocks(blocks, walkshedPoly, allFeatures);
            // Per-route exact-block tabulation: each route's buffer/walkshed
            // features carry route_id, so group by it and tabulate that route's
            // blocks the same way as the system (union semantics, counted once).
            routeBlockResults = routes.map((route) => {
              const feats = allFeatures.filter((f) => f.properties?.route_id === route.route_id);
              const poly = unionWalkshedPolygons(feats);
              return { routeId: route.route_id, result: tabulateBlocks(blocks, poly, feats) };
            });
          }
        } catch (err) {
          console.warn('Block-level coverage unavailable; using block-group estimate.', err);
        }
      }

      setCoverageData({
        blockGroups,
        systemResult,
        routeResults,
        bufferGeoJSON,
        blockResult,
        routeBlockResults,
        walkshed: walkshedByRoute
          ? walkMode === 'auto'
            ? { mode: 'network', auto: true, minutes: null }
            : { mode: 'network', auto: false, minutes: walkMode }
          : { mode: 'buffer' },
      });
    } catch (err) {
      setCoverageError(err instanceof Error ? err.message : 'Failed to fetch coverage data');
    } finally {
      setIsFetchingCoverage(false);
    }
  }, [
    stops,
    routes,
    setCoverageData,
    setIsFetchingCoverage,
    setCoverageError,
    useNetworkWalksheds,
    canUseWalksheds,
    walkMode,
  ]);

  // In a block-level region (US: 50 states + DC) the System Summary +
  // demographic profile render from the EXACT census-block tabulation;
  // elsewhere from the block-group estimate. `summary` is whichever is in effect.
  const block = coverageData?.blockResult ?? null;
  const summary = block ?? coverageData?.systemResult ?? null;

  if (stops.length === 0) {
    return totalRouteCount > 0 && visibleRouteCount === 0 ? (
      <EmptyState
        icon="🚏"
        title="All routes hidden"
        description="Toggle route visibility back on to analyze coverage for those routes."
      />
    ) : (
      <EmptyState
        icon="🚏"
        title="No Stops Yet"
        description="Add stops to your routes before analyzing demographic coverage."
      />
    );
  }

  return (
    <div className="space-y-4">
      <RouteScopeNote visible={visibleRouteCount} total={totalRouteCount} />
      <p className="text-xs text-warm-gray">
        Population, households, workers, and equity demographics within a{' '}
        {useNetworkWalksheds && canUseWalksheds
          ? walkAreaDescription(walkMode)
          : 'straight-line ¼–½ mi buffer'}{' '}
        of stops, from US Census ACS data.
      </p>

      <WalkshedModeControl
        canUse={canUseWalksheds}
        enabled={useNetworkWalksheds}
        onToggle={setUseNetworkWalksheds}
        mode={walkMode}
        onMode={setWalkMode}
      />

      <button
        onClick={handleAnalyze}
        disabled={isFetchingCoverage}
        className="w-full px-4 py-2.5 bg-teal text-white rounded-lg font-heading font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isFetchingCoverage ? 'Analyzing...' : coverageData ? 'Re-analyze Coverage' : 'Analyze Coverage'}
      </button>

      {walkshedNotice && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-xs text-amber-800">{walkshedNotice}</p>
        </div>
      )}

      {isFetchingCoverage && (
        <div className="text-center py-6">
          <div className="inline-block w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin mb-2" />
          <p className="text-sm text-warm-gray">
            {useNetworkWalksheds && canUseWalksheds
              ? 'Computing street-network walksheds…'
              : 'Fetching Census data...'}
          </p>
        </div>
      )}

      {coverageError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700 font-medium">Error</p>
          <p className="text-xs text-red-600 mt-1">{coverageError}</p>
        </div>
      )}

      {coverageData && summary && !isFetchingCoverage && (
        <>
          {/* System summary */}
          <div className="bg-teal-light rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="font-heading font-bold text-sm text-teal flex-1 min-w-0">
                System Summary
                {coverageData.walkshed?.mode === 'network'
                  ? coverageData.walkshed.auto
                    ? ' (auto walk network)'
                    : ` (${coverageData.walkshed.minutes}-min walk network)`
                  : ' (1/4 mi buffer)'}
              </h3>
              <CsvButton
                onClick={() =>
                  exportCsv(
                    'coverage-analysis.csv',
                    buildCoverageCsvRows(coverageData, routes, planHasFeature(plan, 'analysis_basic')),
                  )
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SummaryCard label="Population" value={summary.totalPopulation} />
              <SummaryCard label="Households" value={summary.totalHouseholds} />
              <SummaryCard label="Workers" value={summary.totalWorkers} />
              {/* Jobs and the two union estimates exist ONLY in the exact block
                  layer. In block-group mode they are omitted rather than zeroed:
                  a 0 would read as "nobody", when the truth is "this method
                  cannot answer that". */}
              {block && (
                <>
                  <SummaryCard
                    label="Jobs"
                    value={block.totalJobs}
                    info="Jobs located inside the walkshed, counted at the WORKPLACE (LODES, census-block level). A different universe from every resident count here — never add the two. Only available in the exact block-level analysis."
                  />
                  <SummaryCard
                    label="Ridership propensity"
                    value={block.propensityAll}
                    estimate
                    info="ESTIMATE, not a count. The de-duplicated union of carless and low-income residents: someone who is both is counted once. The ACS publishes no joint distribution below PUMA level, so the overlap is measured from Census PUMS person records. Same model as the demand-dot map. NOT a ridership forecast."
                  />
                  <SummaryCard
                    label="Transit need"
                    value={block.needAll}
                    estimate
                    info="ESTIMATE, not a count. The de-duplicated union of carless, low-income, senior and disabled residents — everyone whose other options are limited by no car, low income, age or disability. Contains Ridership propensity by definition. NOT a ridership forecast."
                  />
                </>
              )}
            </div>
            {block ? (
              <p className="text-[11px] text-warm-gray">
                {formatNumber(block.blocksCovered)} of {formatNumber(block.blocksTotal)} census blocks
                covered (block-level, exact)
              </p>
            ) : (
              <p className="text-[11px] text-warm-gray">
                {coverageData.systemResult.coveredBlockGroupIds.length} of{' '}
                {coverageData.blockGroups.length} block groups covered (estimate)
              </p>
            )}
          </div>

          {/* Definitions for the less-obvious counts, and — where it applies —
              the count-vs-estimate distinction. */}
          <p className="text-[10px] text-warm-gray leading-relaxed">
            <span className="font-semibold text-dark-brown">Workers:</span> employed residents counted
            where they live (ACS means-of-transportation-to-work universe).{' '}
            {block ? (
              <>
                <span className="font-semibold text-dark-brown">Ridership propensity</span> and{' '}
                <span className="font-semibold text-dark-brown">Transit need</span> are{' '}
                <span className="font-semibold">estimates, not counts</span>: de-duplicated unions,
                so a carless low-income resident is counted once, with the overlap measured from
                Census PUMS rather than assumed. Neither predicts boardings.{' '}
                <span className="font-semibold text-dark-brown">Jobs</span> are counted at the
                workplace (LODES) and are summed inside the walkshed in this exact block-level
                analysis — a workplace universe, never added to residents.
              </>
            ) : (
              <>
                <span className="font-semibold text-dark-brown">Ridership propensity</span> and{' '}
                <span className="font-semibold text-dark-brown">Transit need</span> are not reported
                here. They come from the exact census-block layer, which is unavailable for this
                feed; this block-group method pins each block group to its parent tract's centroid,
                and a de-duplicated propensity figure computed on that geometry would be less
                trustworthy than no figure at all. The counts above are unaffected.{' '}
                <span className="font-semibold text-dark-brown">Jobs</span> are likewise
                block-level only, and are not summed into the walkshed here.
              </>
            )}
          </p>

          {block && (
            <p className="text-[10px] text-teal leading-relaxed">
              Exact analysis: counts come from the individual census blocks whose center falls
              inside the walkshed. Categories overlap — do not add them together.
            </p>
          )}

          {/* Demographic profile — coverage vs. county baseline */}
          <DemographicProfile
            coverage={demographicShares(summary)}
            baseline={baselineShares(coverageData.blockGroups)}
          />

          {/* Per-route breakdown (Agency+) */}
          <PaywallOverlay feature="analysis_basic" currentPlan={plan} preview>
            <div className="space-y-2">
              <h3 className="font-heading font-bold text-sm text-dark-brown">
                Per-Route Coverage
              </h3>
              {coverageData.routeResults.map(({ routeId, result }) => {
                const route = routes.find((r) => r.route_id === routeId);
                if (!route) return null;
                // Use the exact per-route block tabulation when available (block
                // regions), else the block-group estimate. Buffer label always
                // comes from the estimate (the block result has no per-route buffer).
                const r = coverageData.routeBlockResults?.find((x) => x.routeId === routeId)?.result ?? result;
                return (
                  <RouteRow
                    key={routeId}
                    routeName={route.route_short_name || route.route_long_name}
                    routeColor={route.route_color}
                    bufferMiles={result.bufferMiles}
                    walkLabel={walkBadgeLabel(coverageData.walkshed)}
                    population={r.totalPopulation}
                    households={r.totalHouseholds}
                    workers={r.totalWorkers}
                    propensityAll={isBlockResult(r) ? r.propensityAll : null}
                  />
                );
              })}
            </div>
          </PaywallOverlay>
        </>
      )}

      {/* Exact census-block walkshed profile — a separate analysis with its own
          run button, its own store slice, and its own (union, never summed)
          aggregation. Independent of the block-group coverage run above. */}
      <WalkshedProfilePanel />
    </div>
  );
}

/**
 * Walkshed-mode selector. Paid users get a checkbox to switch Coverage from the
 * straight-line buffer to Mapbox street-network walksheds plus a walk-time
 * picker; free/pro users see a disabled control with the standard upgrade
 * affordance (a Link to /pricing carrying the feature).
 */
function WalkshedModeControl({
  canUse,
  enabled,
  onToggle,
  mode,
  onMode,
}: {
  canUse: boolean;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  mode: WalkMode;
  onMode: (m: WalkMode) => void;
}) {
  const target = planDisplayName(cheapestPlanFor('network_walksheds'));

  if (!canUse) {
    return (
      <Link
        to="/pricing?feature=network_walksheds"
        className="flex w-full items-center gap-2 rounded-lg border border-sand bg-cream px-3 py-2 text-xs font-semibold text-warm-gray transition-colors hover:border-teal hover:text-teal"
        title="Replace the straight-line buffer with real walking-time isochrones — a Planner plan feature"
      >
        <span aria-hidden>🚶</span>
        <span>Network walksheds (street distance)</span>
        <span className="ml-auto rounded border border-sand bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warm-gray">
          {target}
        </span>
      </Link>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-sand bg-cream p-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm text-dark-brown">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 accent-teal"
        />
        <span className="font-semibold">Network walksheds (street distance)</span>
      </label>
      {enabled && (
        <div className="space-y-1.5 pl-6">
          <div className="flex items-center gap-2">
            <label className="text-xs text-warm-gray" htmlFor="walk-mode">
              Walk time
            </label>
            <select
              id="walk-mode"
              value={String(mode)}
              onChange={(e) =>
                onMode(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as WalkMode))
              }
              className="rounded border border-sand bg-white px-2 py-1 text-xs text-dark-brown"
            >
              {WALK_MODE_OPTIONS.map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {mode === 'auto' && (
            <p className="text-[11px] text-warm-gray">
              Each stop's walkshed is sized by its service frequency:{' '}
              {AUTO_FREQUENT_MINUTES}-min (≈½ mi) where headway is ≤ {FREQUENT_HEADWAY_MAX_MIN} min,
              otherwise {AUTO_INFREQUENT_MINUTES}-min (≈¼ mi).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const SHARE_LABELS: { key: keyof DemographicShares; label: string }[] = [
  { key: 'minority', label: 'Minority' },
  { key: 'lowIncome', label: 'Low-income (<200% FPL)' },
  { key: 'zeroVehicle', label: 'Zero-vehicle HH' },
  { key: 'senior', label: 'Age 65+' },
  { key: 'youth', label: 'Age under 18' },
];

function pctOrDash(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

/**
 * Coverage-area demographic shares vs. the county baseline. The ratio
 * (coverage ÷ baseline) is the equity signal: > 1 over-represents the group in
 * the served area, < 1 under-represents it. Mirrors the Title VI panel's
 * ratio coloring (≥1 good, ≥0.8 moderate, else disparity).
 */
function DemographicProfile({ coverage, baseline }: { coverage: DemographicShares; baseline: DemographicShares }) {
  return (
    <div className="space-y-2">
      <h3 className="font-heading font-bold text-sm text-dark-brown">Demographic profile</h3>
      <div className="overflow-x-auto">
      <div className="border border-sand rounded-lg overflow-hidden min-w-[280px]">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-cream text-warm-gray uppercase tracking-wide">
              <th className="px-2 py-1.5 text-left font-semibold">Group</th>
              <th className="px-2 py-1.5 text-right font-semibold">Coverage</th>
              <th className="px-2 py-1.5 text-right font-semibold">County</th>
              <th className="px-2 py-1.5 text-right font-semibold">Ratio</th>
            </tr>
          </thead>
          <tbody>
            {SHARE_LABELS.map(({ key, label }, i) => {
              const cov = coverage[key];
              const base = baseline[key];
              const ratio = cov != null && base != null && base > 0 ? cov / base : null;
              const ratioColor =
                ratio == null ? 'text-warm-gray' :
                ratio >= 1.0 ? 'text-emerald-600' :
                ratio >= 0.8 ? 'text-amber-600' : 'text-red-600';
              return (
                <tr key={key} className={i % 2 ? 'bg-cream/50' : ''}>
                  <td className="px-2 py-1 text-dark-brown">{label}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-dark-brown">{pctOrDash(cov)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-warm-gray">{pctOrDash(base)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums font-semibold ${ratioColor}`}>
                    {ratio == null ? '—' : ratio.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
      <p className="text-[10px] text-warm-gray">
        Ratio = coverage share ÷ county share. Above 1.0 means the served area over-represents that
        group; below 0.8 may warrant a closer look. Source: ACS 5-year (2022), block-group level.
      </p>
    </div>
  );
}

/**
 * One headline number. `estimate` marks it as a modelled union rather than an
 * ACS count and colors it accordingly — the same amber "est." affordance the
 * walkshed profile table uses, and the same distinction the demand-dot layer
 * control draws with its "estimate" / "ACS count" badges. Three surfaces, one
 * vocabulary.
 */
function SummaryCard({
  label,
  value,
  info,
  estimate = false,
}: {
  label: string;
  value: number;
  info?: string;
  estimate?: boolean;
}) {
  return (
    <div className="text-center">
      <p
        className={`font-heading font-bold text-lg ${estimate ? 'text-amber-700' : 'text-dark-brown'}`}
      >
        {formatNumber(value)}
      </p>
      <p className="text-[11px] text-warm-gray inline-flex items-center justify-center gap-0.5">
        {label}
        {estimate && (
          <span className="rounded border border-amber-300 bg-amber-50 px-1 text-[9px] font-bold uppercase tracking-wide text-amber-700">
            est.
          </span>
        )}
        {info && (
          <span
            title={info}
            aria-label={info}
            role="img"
            className="text-warm-gray/80 hover:text-teal cursor-help leading-none"
          >
            ⓘ
          </span>
        )}
      </p>
    </div>
  );
}

function RouteRow({
  routeName,
  routeColor,
  bufferMiles,
  walkLabel,
  population,
  households,
  workers,
  propensityAll,
}: {
  routeName: string;
  routeColor: string;
  bufferMiles: number;
  /** Network-mode walk-time badge ('auto' / '10 min walk'); null = straight-line. */
  walkLabel: string | null;
  population: number;
  households: number;
  workers: number;
  /** The de-duplicated propensity union, or null when this route was tabulated by
   *  the block-group method, which cannot produce it. Rendered as an em-dash, not
   *  a zero. */
  propensityAll: number | null;
}) {
  return (
    <div className="bg-cream rounded-lg p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: `#${routeColor}` }}
        />
        <span className="font-heading font-bold text-sm text-dark-brown truncate">
          {routeName}
        </span>
        <span className="ml-auto text-[11px] text-warm-gray whitespace-nowrap">
          {bufferLabel(bufferMiles, walkLabel)}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1 text-center">
        <div>
          <p className="font-heading font-bold text-sm text-dark-brown">{formatNumber(population)}</p>
          <p className="text-[10px] text-warm-gray">Pop.</p>
        </div>
        <div>
          <p className="font-heading font-bold text-sm text-dark-brown">{formatNumber(households)}</p>
          <p className="text-[10px] text-warm-gray">HH</p>
        </div>
        <div>
          <p className="font-heading font-bold text-sm text-dark-brown">{formatNumber(workers)}</p>
          <p className="text-[10px] text-warm-gray">Workers</p>
        </div>
        <div
          title={
            propensityAll == null
              ? 'Ridership propensity needs the exact census-block layer, which is not available for this feed.'
              : 'Ridership propensity — ESTIMATE, not a count. The de-duplicated union of carless and low-income residents. Not a ridership forecast.'
          }
        >
          <p
            className={`font-heading font-bold text-sm ${
              propensityAll == null ? 'text-warm-gray' : 'text-amber-700'
            }`}
          >
            {propensityAll == null ? '—' : formatNumber(propensityAll)}
          </p>
          <p className="text-[10px] text-warm-gray">Propensity{propensityAll != null && ' (est.)'}</p>
        </div>
      </div>
    </div>
  );
}
