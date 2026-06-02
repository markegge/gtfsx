import { useCallback } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { useVisibleFeed } from '../../hooks/useVisibleFeed';
import { RouteScopeNote } from '../ui/RouteScopeNote';
import { fetchCensusData, lookupFips } from '../../services/demographics';
import {
  getBufferForRoute,
  generateBufferGeoJSON,
  coverageFromFractions,
  demographicShares,
  baselineShares,
  type DemographicShares,
} from '../../services/coverageAnalysis';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function CoveragePanel() {
  // Analysis is scoped to routes toggled visible on the map (scenario compare).
  const { stops, routes, visibleRouteCount, totalRouteCount } = useVisibleFeed();
  const coverageData = useStore((s) => s.coverageData);
  const isFetchingCoverage = useStore((s) => s.isFetchingCoverage);
  const coverageError = useStore((s) => s.coverageError);
  const setCoverageData = useStore((s) => s.setCoverageData);
  const setIsFetchingCoverage = useStore((s) => s.setIsFetchingCoverage);
  const setCoverageError = useStore((s) => s.setCoverageError);

  const handleAnalyze = useCallback(async () => {
    if (stops.length === 0) return;

    setIsFetchingCoverage(true);
    setCoverageError(null);

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

      // Per-route coverage (uses per-route buffer: 0.5mi for light rail /
      // headway ≤15min, 0.25mi otherwise)
      const routeResults = routes.map((route) => ({
        routeId: route.route_id,
        result: getBufferForRoute(route.route_id, state, blockGroups),
      }));

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

      // Generate buffer GeoJSON for map display
      // Combine buffers: for each route, use its specific buffer distance
      const allFeatures: GeoJSON.Feature[] = [];
      for (const { routeId, result } of routeResults) {
        const routeStopIds = new Set(
          state.routeStops
            .filter((rs) => rs.route_id === routeId)
            .map((rs) => rs.stop_id),
        );
        const routeStops = state.stops.filter((s) => routeStopIds.has(s.stop_id));
        const route = state.routes.find((r) => r.route_id === routeId);
        const bufferGeo = generateBufferGeoJSON(routeStops, result.bufferMiles);
        for (const feat of bufferGeo.features) {
          feat.properties = {
            ...feat.properties,
            route_id: routeId,
            route_color: route ? `#${route.route_color}` : '#888888',
          };
          allFeatures.push(feat);
        }
      }

      const bufferGeoJSON: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: allFeatures,
      };

      setCoverageData({ blockGroups, systemResult, routeResults, bufferGeoJSON });
    } catch (err) {
      setCoverageError(err instanceof Error ? err.message : 'Failed to fetch coverage data');
    } finally {
      setIsFetchingCoverage(false);
    }
  }, [stops, routes, setCoverageData, setIsFetchingCoverage, setCoverageError]);

  if (stops.length === 0) {
    return totalRouteCount > 0 && visibleRouteCount === 0 ? (
      <EmptyState
        icon="🚏"
        title="All routes hidden"
        description="Toggle route visibility back on to analyze coverage for that scenario."
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
        Population, households, workers, and equity demographics within a straight-line ¼–½ mi
        buffer of stops, from US Census ACS data. Buffers approximate walking reach; true
        street-network walksheds are a future enhancement.
      </p>

      <button
        onClick={handleAnalyze}
        disabled={isFetchingCoverage}
        className="w-full px-4 py-2.5 bg-teal text-white rounded-lg font-heading font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isFetchingCoverage ? 'Analyzing...' : coverageData ? 'Re-analyze Coverage' : 'Analyze Coverage'}
      </button>

      {isFetchingCoverage && (
        <div className="text-center py-6">
          <div className="inline-block w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin mb-2" />
          <p className="text-sm text-warm-gray">Fetching Census data...</p>
        </div>
      )}

      {coverageError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700 font-medium">Error</p>
          <p className="text-xs text-red-600 mt-1">{coverageError}</p>
        </div>
      )}

      {coverageData && !isFetchingCoverage && (
        <>
          {/* System summary */}
          <div className="bg-teal-light rounded-lg p-3 space-y-2">
            <h3 className="font-heading font-bold text-sm text-teal">
              System Summary (1/4 mi buffer)
            </h3>
            <div className="grid grid-cols-3 gap-2">
              <SummaryCard label="Population" value={coverageData.systemResult.totalPopulation} />
              <SummaryCard label="Households" value={coverageData.systemResult.totalHouseholds} />
              <SummaryCard label="Workers" value={coverageData.systemResult.totalWorkers} />
            </div>
            <p className="text-[11px] text-warm-gray">
              {coverageData.systemResult.coveredBlockGroupIds.length} of{' '}
              {coverageData.blockGroups.length} block groups covered
            </p>
          </div>

          {/* Demographic profile — coverage vs. county baseline */}
          <DemographicProfile
            coverage={demographicShares(coverageData.systemResult)}
            baseline={baselineShares(coverageData.blockGroups)}
          />

          {/* Per-route breakdown */}
          <div className="space-y-2">
            <h3 className="font-heading font-bold text-sm text-dark-brown">
              Per-Route Coverage
            </h3>
            {coverageData.routeResults.map(({ routeId, result }) => {
              const route = routes.find((r) => r.route_id === routeId);
              if (!route) return null;
              return (
                <RouteRow
                  key={routeId}
                  routeName={route.route_short_name || route.route_long_name}
                  routeColor={route.route_color}
                  bufferMiles={result.bufferMiles}
                  population={result.totalPopulation}
                  households={result.totalHouseholds}
                  workers={result.totalWorkers}
                />
              );
            })}
          </div>
        </>
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
      <div className="border border-sand rounded-lg overflow-hidden">
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
      <p className="text-[10px] text-warm-gray">
        Ratio = coverage share ÷ county share. Above 1.0 means the served area over-represents that
        group; below 0.8 may warrant a closer look. Source: ACS 5-year (2022), block-group level.
      </p>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="font-heading font-bold text-lg text-dark-brown">{formatNumber(value)}</p>
      <p className="text-[11px] text-warm-gray">{label}</p>
    </div>
  );
}

function RouteRow({
  routeName,
  routeColor,
  bufferMiles,
  population,
  households,
  workers,
}: {
  routeName: string;
  routeColor: string;
  bufferMiles: number;
  population: number;
  households: number;
  workers: number;
}) {
  const bufferLabel = bufferMiles === 0.5 ? '1/2 mi' : '1/4 mi';

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
          {bufferLabel}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-center">
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
      </div>
    </div>
  );
}
