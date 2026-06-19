import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { calculateRouteSpans, applyRouteCosts, calculateSystemPeakVehicles } from '../../services/costEstimation';
import type { RouteStats } from '../../services/costEstimation';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { RailSubHeading } from '../ui/RailHeadings';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';
import { useVisibleFeed } from '../../hooks/useVisibleFeed';

function formatCurrency(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

export function CostSummary() {
  const {
    calendars, calendarDates, frequencies,
    selectRoute, setEditingRouteId, setSidebarSection,
  } = useStore();
  // Analysis is scoped to the routes toggled visible on the map.
  const { routes, trips, stopTimes } = useVisibleFeed();
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();
  // System totals (above) are free; the route-level breakdown + CSV export are
  // Agency+ (analysis_basic) — the whole per-route section is gated below.
  const plan = useEditorPlan();

  const [defaultCostPerHour, setDefaultCostPerHour] = useState(100);
  const [deadheadFactor, setDeadheadFactor] = useState(1.1);

  const stateSlice = useMemo(
    () => ({ routes, trips, stopTimes, calendars, calendarDates, frequencies, stopTimesByTrip }),
    [routes, trips, stopTimes, calendars, calendarDates, frequencies, stopTimesByTrip]
  );

  // TRUE whole-system peak (max simultaneous vehicles), NOT the sum of per-route
  // peaks below. Depends only on the feed shape, so it's memoized on stateSlice.
  const systemPeakVehicles = useMemo(
    () => calculateSystemPeakVehicles(stateSlice),
    [stateSlice]
  );

  // Phase 2: Memoize spans separately — these only change when trips/stopTimes change
  const routeSpans = useMemo(() => {
    return routes.map((route) => ({
      route,
      spans: calculateRouteSpans(route.route_id, stateSlice),
    }));
  }, [routes, stateSlice]);

  // Phase 2: Apply costs cheaply — recalculates when cost/deadhead inputs change
  const routeRows = useMemo(() => {
    return routeSpans.map(({ route, spans }) => {
      const costPerHour = route._cost_per_revenue_hour ?? defaultCostPerHour;
      return {
        route,
        stats: applyRouteCosts(spans, costPerHour, deadheadFactor),
      };
    });
  }, [routeSpans, defaultCostPerHour, deadheadFactor]);

  const systemStats = useMemo(() => {
    let totalRevenueHoursWeekly = 0;
    let totalHoursWeekly = 0;
    let totalTripsPerWeek = 0;
    let totalPeakVehicles = 0;
    let totalWeeklyCost = 0;
    let totalAnnualCost = 0;

    for (const { stats } of routeRows) {
      totalRevenueHoursWeekly += stats.revenueHoursWeekly;
      totalHoursWeekly += stats.totalHoursWeekly;
      totalTripsPerWeek += stats.tripsPerWeek;
      totalPeakVehicles += stats.peakVehicles;
      totalWeeklyCost += stats.weeklyCost;
      totalAnnualCost += stats.annualCost;
    }

    return {
      totalRevenueHoursWeekly,
      totalHoursWeekly,
      totalTripsPerWeek,
      totalPeakVehicles,
      totalWeeklyCost,
      totalAnnualCost,
    };
  }, [routeRows]);

  const handleOpenRoute = (routeId: string) => {
    selectRoute(routeId);
    setEditingRouteId(routeId);
    setSidebarSection('routes');
  };

  return (
    <div>
      <RailSubHeading>Assumptions</RailSubHeading>
      <div className="bg-cream rounded-lg p-4 mb-5">
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="min-w-0">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Cost per Revenue Hour
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-dark-brown font-semibold">$</span>
              <input
                type="number"
                min={0}
                step={1}
                value={defaultCostPerHour}
                onChange={(e) => setDefaultCostPerHour(Math.max(0, Number(e.target.value)))}
                className="flex-1 min-w-0 px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-white focus:outline-none focus:border-coral tabular-nums"
              />
              <span className="text-xs text-warm-gray whitespace-nowrap">/ hr</span>
            </div>
          </div>
          <div className="min-w-0">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Deadhead Factor
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={3}
                step={0.05}
                value={deadheadFactor}
                onChange={(e) => setDeadheadFactor(Math.max(1, Math.min(3, Number(e.target.value))))}
                className="flex-1 min-w-0 px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-white focus:outline-none focus:border-coral tabular-nums"
              />
              <span className="text-xs text-warm-gray whitespace-nowrap">× rev hrs</span>
            </div>
          </div>
        </div>
        <p className="text-[11px] text-warm-gray leading-relaxed">
          Deadhead accounts for non-revenue time (deadheading, layovers, pull-out/pull-in). Total operating hours = revenue hours × {deadheadFactor}.
        </p>
      </div>

      <RailSubHeading>System Totals</RailSubHeading>
      <div className="bg-cream rounded-lg p-4 mb-5">
        <div className="flex flex-col gap-1.5 text-sm">
          <StatRow label="Weekly Revenue Hours" value={systemStats.totalRevenueHoursWeekly.toFixed(1)} />
          <StatRow label="Weekly Total Hours" value={systemStats.totalHoursWeekly.toFixed(1)} sub={`× ${deadheadFactor}`} />
          <StatRow label="Total Trips / Week" value={String(systemStats.totalTripsPerWeek)} />
          <StatRow
            label="Vehicles for Peak Service"
            value={String(systemPeakVehicles)}
            title={`Max vehicles simultaneously in service at the busiest instant on the busiest service day — the fleet you need to run the schedule. ≤ the sum of per-route peaks (${systemStats.totalPeakVehicles}), which routes never all hit at once.`}
          />
          <div className="h-px bg-sand my-1" />
          <StatRow label="Weekly Cost" value={formatCurrency(systemStats.totalWeeklyCost)} highlight />
          <StatRow label="Annual Cost" value={formatCurrency(systemStats.totalAnnualCost)} highlight />
        </div>
        <p className="text-[11px] text-warm-gray leading-relaxed mt-2.5">
          Vehicles for peak service is the most vehicles in service at one instant on the busiest service day — the fleet required to operate the schedule. It is ≤ the sum of each route&rsquo;s peak ({systemStats.totalPeakVehicles}), since routes peak at different times of day.
        </p>
      </div>

      <PaywallOverlay feature="analysis_basic" currentPlan={plan} preview>
      <RailSubHeading count={routes.length}>Per-Route Breakdown</RailSubHeading>

      {routes.length === 0 ? (
        <p className="text-xs text-warm-gray">No routes created yet.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {routeRows.map(({ route, stats }) => {
              const hasCustomCost = route._cost_per_revenue_hour != null && route._cost_per_revenue_hour > 0;
              return (
                <RouteCard
                  key={route.route_id}
                  name={route.route_short_name || route.route_long_name || 'Untitled Route'}
                  color={route.route_color}
                  stats={stats}
                  costPerHour={hasCustomCost ? route._cost_per_revenue_hour! : defaultCostPerHour}
                  isDefault={!hasCustomCost}
                  onEditRoute={() => handleOpenRoute(route.route_id)}
                />
              );
            })}
          </div>
          <button
            onClick={() => {
              const rows = [
                ['Route', 'Rev Hours/Wk', 'Total Hours/Wk', 'Trips/Wk', 'Peak Vehicles', 'Cost/Hour', 'Weekly Cost', 'Annual Cost'],
                ...routeRows.map(({ route, stats }) => {
                  const cph = (route._cost_per_revenue_hour != null && route._cost_per_revenue_hour > 0)
                    ? route._cost_per_revenue_hour : defaultCostPerHour;
                  return [
                    route.route_short_name || route.route_long_name || route.route_id,
                    stats.revenueHoursWeekly.toFixed(1),
                    stats.totalHoursWeekly.toFixed(1),
                    String(stats.tripsPerWeek),
                    String(stats.peakVehicles),
                    String(cph),
                    String(Math.round(stats.weeklyCost)),
                    String(Math.round(stats.annualCost)),
                  ];
                }),
                [],
                // System peak = max simultaneous vehicles (≤ sum of route peaks),
                // the real fleet need — not a column sum.
                ['TOTAL', systemStats.totalRevenueHoursWeekly.toFixed(1), systemStats.totalHoursWeekly.toFixed(1),
                  String(systemStats.totalTripsPerWeek), String(systemPeakVehicles), '',
                  String(Math.round(systemStats.totalWeeklyCost)), String(Math.round(systemStats.totalAnnualCost))],
              ];
              const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'cost_analysis.csv';
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="mt-4 w-full px-3 py-2 border-2 border-dashed border-sand rounded-lg text-xs font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors flex items-center justify-center gap-1.5"
          >
            Export to CSV
          </button>
        </>
      )}
      </PaywallOverlay>
    </div>
  );
}

function StatRow({ label, value, highlight, sub, title }: { label: string; value: string; highlight?: boolean; sub?: string; title?: string }) {
  return (
    <div className="flex justify-between" title={title}>
      <span className={`text-warm-gray${title ? ' cursor-help decoration-dotted underline decoration-warm-gray/40 underline-offset-2' : ''}`}>{label}</span>
      <span className={`font-semibold ${highlight ? 'text-coral' : 'text-dark-brown'}`}>
        {value}
        {sub && <span className="text-warm-gray font-normal text-[11px] ml-1">{sub}</span>}
      </span>
    </div>
  );
}

function RouteCard({
  name,
  color,
  stats,
  costPerHour,
  isDefault,
  onEditRoute,
}: {
  name: string;
  color: string;
  stats: RouteStats;
  costPerHour: number;
  isDefault: boolean;
  onEditRoute: () => void;
}) {
  return (
    <div className="border-2 border-sand rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: `#${color}` }}
        />
        <span className="font-semibold text-sm text-dark-brown truncate flex-1">{name}</span>
        <button
          onClick={onEditRoute}
          className="text-[11px] font-semibold text-warm-gray hover:text-coral transition-colors"
        >
          Edit
        </button>
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <div className="flex justify-between">
          <span className="text-warm-gray">Rev Hours / Wk</span>
          <span className="text-dark-brown font-medium">{stats.revenueHoursWeekly.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Total Hours / Wk</span>
          <span className="text-dark-brown font-medium">{stats.totalHoursWeekly.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Trips / Wk</span>
          <span className="text-dark-brown font-medium">{stats.tripsPerWeek}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Peak Vehicles</span>
          <span className="text-dark-brown font-medium">{stats.peakVehicles}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Cost/Hour</span>
          <span className="text-dark-brown font-medium">
            ${costPerHour}
            {isDefault && <span className="text-warm-gray ml-1">(default)</span>}
          </span>
        </div>
        <div className="h-px bg-sand my-0.5" />
        <div className="flex justify-between">
          <span className="text-warm-gray">Weekly Cost</span>
          <span className="text-coral font-semibold">{formatCurrency(stats.weeklyCost)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Annual Cost</span>
          <span className="text-coral font-semibold">{formatCurrency(stats.annualCost)}</span>
        </div>
      </div>
    </div>
  );
}
