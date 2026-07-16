import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { computeShapePatterns } from '../ui/shapePatterns';
import { PatternSelector } from '../ui/ShapePatternSelector';
import { directionName } from '../../utils/constants';
import { secondsToGtfsTime, formatTimeShort } from '../../utils/time';
import { buildMareyData } from '../../services/marey';
import { expandFrequencyTrip, type FrequencyWindow } from '../../services/frequencyExpansion';
import type { Route } from '../../types/gtfs';

// Layout constants for the SVG chart. The plot area sits inside these margins;
// stop-name labels live in the left margin, the time axis in the bottom one.
const MARGIN = { top: 16, right: 24, bottom: 32, left: 150 };
const PX_PER_HOUR = 80; // horizontal scale — widens the chart so headways read
const ROW_GAP = 22;     // minimum vertical px between adjacent stop gridlines

/**
 * Marey time–distance diagram for the selected route.
 *
 * x = time of day, y = distance along the route (stops in order). One polyline
 * per trip connects its stop_times, coloured with the route colour. Scoped to
 * the same route + service + shape/direction the Timetable tab uses, so the two
 * views stay consistent.
 */
export function MareyChart() {
  const { selectedRouteId, selectRoute, routes, trips, stops, routeStops, calendars, shapes } = useStore();
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();

  const directionId = useStore((s) => s.timetableDirectionId);
  const setDirectionId = useStore((s) => s.setTimetableDirectionId);
  const selectedServiceId = useStore((s) => s.timetableServiceId);
  const setSelectedServiceId = useStore((s) => s.setTimetableServiceId);
  const selectedShapeId = useStore((s) => s.timetableShapeId);
  const setSelectedShapeId = useStore((s) => s.setTimetableShapeId);

  const route = routes.find((r) => r.route_id === selectedRouteId);

  const activeServiceId = useMemo(() => {
    if (selectedServiceId && calendars.some((c) => c.service_id === selectedServiceId)) return selectedServiceId;
    return calendars[0]?.service_id || null;
  }, [selectedServiceId, calendars]);

  // Mirror TimetableGrid's pattern handling so the chart shows the same scope.
  const patterns = useMemo(
    () => computeShapePatterns(selectedRouteId, trips, routeStops),
    [selectedRouteId, trips, routeStops],
  );
  const effectiveShapeId = useMemo(() => {
    if (patterns.length === 0) return null;
    return patterns.some((p) => p.shapeId === selectedShapeId) ? selectedShapeId : patterns[0].shapeId;
  }, [patterns, selectedShapeId]);

  // Ordered stops — per-shape when a shape is selected, else by direction.
  const orderedStops = useMemo(() => {
    if (!selectedRouteId) return [];
    const list = effectiveShapeId
      ? routeStops.filter((rs) => rs.route_id === selectedRouteId && rs.shape_id === effectiveShapeId)
      : routeStops.filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === directionId);
    return [...list]
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as typeof stops;
  }, [selectedRouteId, effectiveShapeId, directionId, routeStops, stops]);

  // Trips for this route + service + shape/direction (same filter as Timetable).
  const routeTrips = useMemo(() => {
    if (!selectedRouteId) return [];
    return trips.filter((t) => t.route_id === selectedRouteId
      && (!activeServiceId || t.service_id === activeServiceId)
      && (effectiveShapeId ? t.shape_id === effectiveShapeId : t.direction_id === directionId));
  }, [selectedRouteId, trips, activeServiceId, effectiveShapeId, directionId]);

  const shape = useMemo(
    () => (effectiveShapeId ? shapes.find((s) => s.shape_id === effectiveShapeId) : undefined),
    [effectiveShapeId, shapes],
  );

  // Frequency build-out — the SAME pure expansion the grid uses (item #10). Any
  // template trip in scope contributes its full run of projected departures as
  // derived lines. Re-derives whenever the template's stop_times change.
  const frequencies = useStore((s) => s.frequencies);
  const virtualTrips = useMemo(() => {
    if (frequencies.length === 0) return [];
    const byTrip = new Map<string, FrequencyWindow[]>();
    for (const f of frequencies) {
      const w: FrequencyWindow = { start_time: f.start_time, end_time: f.end_time, headway_secs: f.headway_secs, exact_times: f.exact_times };
      const arr = byTrip.get(f.trip_id);
      if (arr) arr.push(w); else byTrip.set(f.trip_id, [w]);
    }
    return routeTrips.flatMap((t) => {
      const windows = byTrip.get(t.trip_id);
      const sts = stopTimesByTrip.get(t.trip_id);
      return windows && windows.length && sts ? expandFrequencyTrip(t.trip_id, sts, windows) : [];
    });
  }, [frequencies, routeTrips, stopTimesByTrip]);

  const data = useMemo(
    () => buildMareyData({ orderedStops, shape, trips: routeTrips, stopTimesByTrip, virtualTrips }),
    [orderedStops, shape, routeTrips, stopTimesByTrip, virtualTrips],
  );

  if (!route) {
    if (routes.length > 0) selectRoute(routes[0].route_id);
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        {routes.length === 0 ? 'Create a route first' : 'Select a route to see its time–distance chart'}
      </div>
    );
  }

  const routeColor = `#${route.route_color || '888888'}`;

  return (
    <div className="p-2 flex flex-col min-h-0 flex-1">
      {/* Controls — route / service / pattern, matching the Timetable header */}
      <div className="flex items-center gap-2 mb-2 px-2 shrink-0 flex-wrap">
        <select
          value={selectedRouteId || ''}
          onChange={(e) => selectRoute(e.target.value || null)}
          className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
        >
          {routes.map((r) => (
            <option key={r.route_id} value={r.route_id}>
              {r.route_short_name || r.route_long_name || r.route_id}
            </option>
          ))}
        </select>
        {calendars.length > 0 && (
          <select
            value={activeServiceId || ''}
            onChange={(e) => setSelectedServiceId(e.target.value)}
            className="px-2 py-1 border border-sand rounded-md text-xs bg-cream focus:outline-none focus:border-coral"
          >
            {calendars.map((cal) => (
              <option key={cal.service_id} value={cal.service_id}>
                {cal._description || cal.service_id}
              </option>
            ))}
          </select>
        )}
        {patterns.length >= 1 ? (
          <PatternSelector
            patterns={patterns}
            selectedShapeId={effectiveShapeId}
            route={route}
            shapes={shapes}
            onChange={(p) => {
              setSelectedShapeId(p.shapeId);
              if (p.directionId !== directionId) setDirectionId(p.directionId);
            }}
          />
        ) : (
          <DirectionSelect directionId={directionId} onChange={setDirectionId} route={route} />
        )}
        {(() => {
          const projected = data.trips.filter((t) => t.derived).length;
          const real = data.trips.length - projected;
          return (
            <span className="text-xs text-warm-gray whitespace-nowrap">
              {real} trip{real === 1 ? '' : 's'} plotted{projected > 0 ? ` · ${projected} projected` : ''}
            </span>
          );
        })()}
        {data.distanceSource !== 'shape' && data.trips.length > 0 && (
          <span
            className="text-[11px] text-warm-gray italic"
            title={
              data.distanceSource === 'stops'
                ? 'No usable route shape — y-axis uses straight-line distance between stops.'
                : 'No coordinates — y-axis spaces stops evenly by sequence.'
            }
          >
            {data.distanceSource === 'stops' ? 'straight-line distance' : 'evenly spaced'}
          </span>
        )}
      </div>

      <MareyBody data={data} routeColor={routeColor} hasStops={orderedStops.length >= 2} />
    </div>
  );
}

function MareyBody({
  data,
  routeColor,
  hasStops,
}: {
  data: ReturnType<typeof buildMareyData>;
  routeColor: string;
  hasStops: boolean;
}) {
  // Which trip is hovered (highlight its line + show its label).
  const [hoverTrip, setHoverTrip] = useState<string | null>(null);

  // Time axis bounds: snap to whole hours around the plotted range, leaving a
  // little padding so the first/last trips aren't flush against the edges.
  const startHour = Math.floor(data.minTimeSec / 3600);
  const endHour = Math.ceil(data.maxTimeSec / 3600);
  const axisStartSec = startHour * 3600;
  const axisEndSec = Math.max(endHour, startHour + 1) * 3600;
  const spanSec = axisEndSec - axisStartSec;

  const plotWidth = Math.max(360, (spanSec / 3600) * PX_PER_HOUR);
  const plotHeight = Math.max(160, (data.stops.length - 1) * ROW_GAP);

  const svgWidth = MARGIN.left + plotWidth + MARGIN.right;
  const svgHeight = MARGIN.top + plotHeight + MARGIN.bottom;

  const xOf = (timeSec: number) =>
    MARGIN.left + ((timeSec - axisStartSec) / spanSec) * plotWidth;
  const yOf = (distanceKm: number) =>
    MARGIN.top + (data.maxDistanceKm > 0 ? (distanceKm / data.maxDistanceKm) * plotHeight : 0);

  // Hour ticks across the bottom axis.
  const hourTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let s = axisStartSec; s <= axisEndSec; s += 3600) ticks.push(s);
    return ticks;
  }, [axisStartSec, axisEndSec]);

  // Y labels can collide on long routes — only label a stop if it's far enough
  // from the previously-labelled one. First and last are always labelled.
  const stopLabels = useMemo(() => {
    const out: { name: string; y: number; show: boolean }[] = [];
    let lastY = -Infinity;
    data.stops.forEach((s, i) => {
      const y = yOf(s.distanceKm);
      const isEnd = i === 0 || i === data.stops.length - 1;
      const show = isEnd || y - lastY >= 14;
      if (show) lastY = y;
      out.push({ name: s.stopName, y, show });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.stops, data.maxDistanceKm, plotHeight]);

  if (!hasStops) {
    return (
      <div className="flex items-center justify-center flex-1 text-warm-gray text-sm">
        Add at least two stops to this route to chart it.
      </div>
    );
  }
  if (data.trips.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 text-warm-gray text-sm">
        No trips with times for this service pattern. Add trips in the Timetable tab.
      </div>
    );
  }

  return (
    <div className="overflow-auto flex-1 min-h-0">
      <svg
        width={svgWidth}
        height={svgHeight}
        className="select-none"
        role="img"
        aria-label="Time-distance chart: one line per trip"
      >
        {/* Stop gridlines (horizontal) + y-axis labels */}
        {data.stops.map((s, i) => {
          const y = yOf(s.distanceKm);
          const label = stopLabels[i];
          return (
            <g key={s.stopId}>
              <line
                x1={MARGIN.left}
                y1={y}
                x2={MARGIN.left + plotWidth}
                y2={y}
                stroke="#EFE7DD"
                strokeWidth={1}
              />
              {label.show && (
                <text
                  x={MARGIN.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-warm-gray"
                  style={{ fontSize: 10 }}
                >
                  {s.stopName.length > 22 ? s.stopName.slice(0, 20) + '…' : s.stopName}
                </text>
              )}
            </g>
          );
        })}

        {/* Hour gridlines (vertical) + time axis labels */}
        {hourTicks.map((sec) => {
          const x = xOf(sec);
          return (
            <g key={sec}>
              <line
                x1={x}
                y1={MARGIN.top}
                x2={x}
                y2={MARGIN.top + plotHeight}
                stroke="#EFE7DD"
                strokeWidth={1}
              />
              <text
                x={x}
                y={MARGIN.top + plotHeight + 16}
                textAnchor="middle"
                className="fill-warm-gray"
                style={{ fontSize: 10 }}
              >
                {formatTimeShort(secondsToGtfsTime(sec))}
              </text>
            </g>
          );
        })}

        {/* Trip polylines — derived (frequency) lines first so the real/template
            lines paint on top. Derived: lighter + dashed (finer dashes when the
            window is approximate, exact_times=0). */}
        {[...data.trips]
          .sort((a, b) => Number(!!a.derived) - Number(!!b.derived))
          .map((trip) => {
            const pts = trip.points
              .map((p) => `${xOf(p.timeSec).toFixed(1)},${yOf(p.distanceKm).toFixed(1)}`)
              .join(' ');
            const isHover = hoverTrip === trip.tripId;
            const dimmed = !!hoverTrip && !isHover;
            const style = trip.derived
              ? { width: isHover ? 2.5 : 1, opacity: dimmed ? 0.12 : 0.42, dash: trip.exactTimes === 0 ? '2 4' : '5 3' }
              : { width: isHover ? 3 : 1.5, opacity: dimmed ? 0.25 : 0.85, dash: undefined as string | undefined };
            return (
              <polyline
                key={trip.tripId}
                points={pts}
                fill="none"
                stroke={routeColor}
                strokeWidth={style.width}
                strokeOpacity={style.opacity}
                strokeDasharray={style.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
                onMouseEnter={() => setHoverTrip(trip.tripId)}
                onMouseLeave={() => setHoverTrip(null)}
                style={{ cursor: 'pointer' }}
              >
                <title>
                  {trip.derived
                    ? `Projected · every ${Math.round((trip.headwaySecs ?? 0) / 60)}m from ${trip.templateTripId}${trip.exactTimes === 0 ? ' (approximate)' : ''}`
                    : `${trip.headsign ? `${trip.headsign} — ` : ''}${trip.tripId}`}
                  {' · '}
                  {formatTimeShort(secondsToGtfsTime(trip.points[0].timeSec))}
                  {' → '}
                  {formatTimeShort(secondsToGtfsTime(trip.points[trip.points.length - 1].timeSec))}
                </title>
              </polyline>
            );
          })}

        {/* Axis frame */}
        <line
          x1={MARGIN.left}
          y1={MARGIN.top}
          x2={MARGIN.left}
          y2={MARGIN.top + plotHeight}
          stroke="#D9CCBC"
          strokeWidth={1}
        />
        <line
          x1={MARGIN.left}
          y1={MARGIN.top + plotHeight}
          x2={MARGIN.left + plotWidth}
          y2={MARGIN.top + plotHeight}
          stroke="#D9CCBC"
          strokeWidth={1}
        />
      </svg>
      {data.trips.some((t) => t.derived) && (
        <p className="text-[11px] text-warm-gray px-2 pb-1">
          Dashed lines are frequency-based departures projected from the template trip; finer dashes mark approximate (exact_times = 0) windows.
        </p>
      )}
      {data.hasOvernight && (
        <p className="text-[11px] text-warm-gray px-2 pb-2">
          Times past midnight (24:00+) are plotted on the same axis continuing rightward.
        </p>
      )}
    </div>
  );
}

/** Direction dropdown for routes with no shapes yet — mirrors the Timetable. */
function DirectionSelect({
  directionId,
  onChange,
  route,
}: {
  directionId: 0 | 1;
  onChange: (d: 0 | 1) => void;
  route?: Route | null;
}) {
  return (
    <select
      value={directionId}
      onChange={(e) => onChange(Number(e.target.value) as 0 | 1)}
      className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
    >
      <option value={0}>{directionName(route, 0)}</option>
      <option value={1}>{directionName(route, 1)}</option>
    </select>
  );
}
