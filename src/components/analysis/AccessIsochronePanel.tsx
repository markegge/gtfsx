import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { representativeDay } from '../../services/stopAnalysis';
import { fetchCensusData, lookupFips } from '../../services/demographics';
import { runAccessIsochrone } from '../../services/accessIsochrone/orchestrator';
import { accessRingColor } from '../../services/accessIsochrone/colors';
import type { WalkMinutes } from '../../services/networkWalkshed';

const BUDGET_OPTIONS = [15, 30, 45, 60];
const WALK_OPTIONS: WalkMinutes[] = [5, 10, 15];

function secToHHMM(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function hhmmToSec(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}
const fmt = (n: number) => Math.round(n).toLocaleString();
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

/**
 * Transit Access Isochrones (#40) — "from a pin, what can a rider reach in N
 * minutes?" Places an origin, runs a schedule-based RAPTOR pass over the
 * in-memory feed, draws time-budget contours on the map, and tallies the
 * population / jobs / equity populations inside each contour. Agency+ (gated by
 * the RightRail wrapper).
 */
export function AccessIsochronePanel() {
  const origin = useStore((s) => s.accessOrigin);
  const params = useStore((s) => s.accessParams);
  const result = useStore((s) => s.accessResult);
  const running = useStore((s) => s.accessRunning);
  const error = useStore((s) => s.accessError);
  const setParams = useStore((s) => s.setAccessParams);
  const setResult = useStore((s) => s.setAccessResult);
  const setRunning = useStore((s) => s.setAccessRunning);
  const setError = useStore((s) => s.setAccessError);
  const clearAll = useStore((s) => s.clearAccessIsochrone);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);
  const calendars = useStore((s) => s.calendars);
  const stops = useStore((s) => s.stops);

  const [loadingCensus, setLoadingCensus] = useState(false);

  const picking = mapMode === 'place_access_origin';

  const toggleBudget = (b: number) => {
    const has = params.budgetsMin.includes(b);
    let next = has ? params.budgetsMin.filter((x) => x !== b) : [...params.budgetsMin, b];
    if (next.length === 0) next = [b]; // never empty
    setParams({ budgetsMin: next.sort((a, c) => a - c) });
  };

  const run = async () => {
    setError(null);
    if (!origin) { setError('Place an origin pin on the map first.'); return; }
    if (stops.length === 0) { setError('This feed has no stops to route over.'); return; }
    setRunning(true);
    try {
      const state = useStore.getState();
      const serviceIds = params.serviceId
        ? [params.serviceId]
        : [...representativeDay(state).serviceIds];

      // Opportunities reuse the Coverage panel's loaded block groups when present;
      // otherwise fetch them once from the stops' centroid county (best-effort —
      // the reach contours still render if this fails).
      let blockGroups = state.coverageData?.blockGroups ?? [];
      if (blockGroups.length === 0) {
        setLoadingCensus(true);
        try {
          const avgLat = stops.reduce((s, st) => s + st.stop_lat, 0) / stops.length;
          const avgLon = stops.reduce((s, st) => s + st.stop_lon, 0) / stops.length;
          const { stateFips, countyFips } = await lookupFips(avgLat, avgLon);
          blockGroups = await fetchCensusData(stateFips, countyFips);
        } catch {
          blockGroups = [];
        } finally {
          setLoadingCensus(false);
        }
      }

      const res = await runAccessIsochrone(
        {
          origin,
          budgetsMin: params.budgetsMin,
          departureSec: params.departureSec,
          serviceIds,
          walkMinutes: params.walkMinutes,
          // Routed egress: real street-network walkshed (Mapbox isochrones) around
          // each reached stop, not a fixed-radius circle.
          straightLineWalk: false,
        },
        state,
        blockGroups,
      );
      setResult(res);
      if (res.status === 'error') setError(res.message ?? 'Analysis failed.');
      else if (res.status === 'empty') setError(res.message ?? 'No stops were reachable from here.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed.');
    } finally {
      setRunning(false);
    }
  };

  // Label for the default "busiest weekday" service-day option.
  const repDayLabel = useMemo(
    () => representativeDay(useStore.getState()).label,
    // Recompute when the calendar/trip set changes (the inputs to the choice).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [calendars.length],
  );

  return (
    <div className="p-4 space-y-4 text-sm overflow-y-auto">
      <div>
        <h2 className="font-heading font-bold text-base text-dark-brown">Access Isochrones</h2>
        <p className="text-xs text-warm-gray mt-0.5">
          From an origin pin, see where a rider can travel on your network within a
          time budget — walk access, wait, and in-vehicle time combined — and the
          population, jobs, and equity populations they can reach.
        </p>
      </div>

      {/* Origin */}
      <div className="rounded-lg border border-sand bg-cream p-3 space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-warm-gray">Origin</div>
        {origin ? (
          <div className="text-xs text-dark-brown">
            {origin.lat.toFixed(5)}, {origin.lon.toFixed(5)}
          </div>
        ) : (
          <div className="text-xs text-warm-gray">No origin placed yet.</div>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => setMapMode(picking ? 'select' : 'place_access_origin')}
            className={`px-3 py-1.5 rounded-lg text-xs font-heading font-bold transition-colors ${
              picking ? 'bg-coral text-white' : 'bg-coral/10 text-coral hover:bg-coral/20'
            }`}
          >
            {picking ? 'Click the map…' : origin ? 'Move origin' : 'Set origin on map'}
          </button>
          {origin && (
            <button
              onClick={clearAll}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-warm-gray border border-sand hover:border-coral hover:text-coral transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Parameters */}
      <div className="space-y-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-warm-gray mb-1">Time budget</div>
          <div className="flex gap-1.5">
            {BUDGET_OPTIONS.map((b) => {
              const on = params.budgetsMin.includes(b);
              return (
                <button
                  key={b}
                  onClick={() => toggleBudget(b)}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold border-2 transition-colors ${
                    on ? 'border-coral bg-coral/10 text-coral' : 'border-sand text-warm-gray hover:border-coral/50'
                  }`}
                >
                  {b}m
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-3">
          <label className="flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-warm-gray mb-1">Departure</div>
            <input
              type="time"
              value={secToHHMM(params.departureSec)}
              onChange={(e) => setParams({ departureSec: hhmmToSec(e.target.value) })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </label>
          <label className="flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-warm-gray mb-1">Service day</div>
            <select
              value={params.serviceId ?? ''}
              onChange={(e) => setParams({ serviceId: e.target.value || null })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">Busiest weekday ({repDayLabel})</option>
              {calendars.map((c) => (
                <option key={c.service_id} value={c.service_id}>{c._description || c.service_id}</option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-warm-gray mb-1">Max walk (access + egress)</div>
          <div className="flex gap-1.5">
            {WALK_OPTIONS.map((w) => (
              <button
                key={w}
                onClick={() => setParams({ walkMinutes: w })}
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold border-2 transition-colors ${
                  params.walkMinutes === w ? 'border-coral bg-coral/10 text-coral' : 'border-sand text-warm-gray hover:border-coral/50'
                }`}
              >
                {w} min
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={run}
        disabled={running || !origin}
        className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {running ? (loadingCensus ? 'Loading demographics…' : 'Analyzing…') : 'Run analysis'}
      </button>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700">{error}</div>
      )}

      {/* Results */}
      {result && result.status === 'ok' && (
        <div className="space-y-3">
          <div className="text-xs text-warm-gray">
            {result.reachedStopCount.toLocaleString()} stops reachable · {result.boardableStopIds.length} boardable on foot
            {result.isochroneRequests > 0 && ` · ${result.isochroneRequests} isochrone requests`}
          </div>
          {result.rings.map((ring, i) => (
            <div key={ring.budgetMin} className="rounded-lg border border-sand overflow-hidden">
              <div
                className="px-3 py-1.5 flex items-center gap-2 text-xs font-heading font-bold text-white"
                style={{ backgroundColor: accessRingColor(i) }}
              >
                <span>{ring.budgetMin} min</span>
                <span className="ml-auto font-semibold opacity-90">{ring.reachedStopIds.length} stops</span>
              </div>
              <div className="p-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {ring.coverage ? (
                  <>
                    <Stat label="Population" value={fmt(ring.coverage.totalPopulation)} />
                    <Stat label="Jobs (workers)" value={fmt(ring.coverage.totalWorkers)} />
                    <Stat label="Minority" value={pct(shareMinority(ring.coverage))} />
                    <Stat label="Low-income" value={pct(shareLowIncome(ring.coverage))} />
                    <Stat label="Zero-vehicle HH" value={pct(shareZeroVeh(ring.coverage))} />
                  </>
                ) : (
                  <div className="col-span-2 text-warm-gray">
                    No demographics loaded for this area — reach contour shown on the map.
                  </div>
                )}
              </div>
            </div>
          ))}
          <p className="text-[10px] text-warm-gray/80 leading-snug">
            Estimate. Egress drawn as street-network walksheds (Mapbox walking isochrones)
            around each reached stop; schedule-based routing (RAPTOR) over the busiest
            representative day. Equity shares are apportioned from ACS block groups overlapping
            the reachable area.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-warm-gray">{label}</span>
      <span className="font-semibold text-dark-brown">{value}</span>
    </div>
  );
}

// CoverageResult carries raw numerators/denominators; derive equity shares the
// same way the coverage profile does.
function shareMinority(c: { minorityPop: number; totalRacePop: number }): number | null {
  return c.totalRacePop > 0 ? c.minorityPop / c.totalRacePop : null;
}
function shareLowIncome(c: { lowIncomePop: number; povertyUniverse: number }): number | null {
  return c.povertyUniverse > 0 ? c.lowIncomePop / c.povertyUniverse : null;
}
function shareZeroVeh(c: { zeroVehicleHouseholds: number; occupiedHouseholds: number }): number | null {
  return c.occupiedHouseholds > 0 ? c.zeroVehicleHouseholds / c.occupiedHouseholds : null;
}
