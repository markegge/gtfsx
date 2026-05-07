import { useCallback } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { fetchCensusData, lookupFips } from '../../services/demographics';
import {
  getBufferForRoute,
  generateBufferGeoJSON,
  type CoverageResult,
} from '../../services/coverageAnalysis';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function CoveragePanel() {
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
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
      // fraction across all routes, then sum apportioned populations.
      const bgMap = new Map(blockGroups.map((bg) => [bg.geoid, bg]));
      const systemFractions = new Map<string, number>();
      for (const { result } of routeResults) {
        for (const [geoid, f] of result.fractions) {
          if ((systemFractions.get(geoid) ?? 0) < f) systemFractions.set(geoid, f);
        }
      }
      let sysPop = 0, sysHH = 0, sysWorkers = 0;
      for (const [geoid, f] of systemFractions) {
        const bg = bgMap.get(geoid);
        if (bg) { sysPop += f * bg.population; sysHH += f * bg.households; sysWorkers += f * bg.workers; }
      }
      const systemResult: CoverageResult = {
        totalPopulation:      Math.round(sysPop),
        totalHouseholds:      Math.round(sysHH),
        totalWorkers:         Math.round(sysWorkers),
        coveredBlockGroupIds: [...systemFractions.keys()],
        bufferMiles:          0.25,
        fractions:            systemFractions,
      };

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
    return (
      <EmptyState
        icon="🚏"
        title="No Stops Yet"
        description="Add stops to your routes before analyzing demographic coverage."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading font-bold text-base text-dark-brown mb-1">
          Demographic Coverage
        </h2>
        <p className="text-xs text-warm-gray">
          Analyze population, households, and workers within walking distance of stops using US Census data.
        </p>
      </div>

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
