import { useState, useMemo, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  MeasuringStrategy,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { PatternSelector } from '../ui/ShapePatternSelector';
import { computeShapePatterns } from '../ui/shapePatterns';
import { directionName } from '../../utils/constants';
import type { Stop } from '../../types/gtfs';

function SortableStopItem({
  stop,
  index,
  isSelected,
  routeColor,
  onSelect,
  onEdit,
  onRemove,
}: {
  stop: Stop;
  index: number;
  isSelected: boolean;
  routeColor: string;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useSortable({ id: stop.stop_id });

  // No `transition` on the item — dnd-kit's default 200ms transform tween
  // leaves rows visually behind their DOM hit-areas during the drop
  // animation, so hovering one row highlights the row above it for a
  // beat. Snap reorder instead; the drag itself stays smooth because
  // `transform` updates frame-by-frame while the pointer is moving.
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors group
        ${isSelected ? 'bg-sand' : 'hover:bg-cream'}
        ${isDragging ? 'shadow-md' : ''}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="text-warm-gray hover:text-dark-brown cursor-grab active:cursor-grabbing text-[10px] shrink-0 w-4 text-center touch-none"
        title="Drag to reorder"
      >
        ⠿
      </button>
      <span className="text-warm-gray text-[11px] w-4 text-right shrink-0">{index + 1}</span>
      <div
        className="w-2.5 h-2.5 rounded-full border-2 shrink-0"
        style={{ borderColor: routeColor, backgroundColor: isSelected ? routeColor : 'white' }}
      />
      <button
        onClick={onSelect}
        className="flex flex-col min-w-0 flex-1 text-left"
      >
        <span className="text-xs font-medium text-dark-brown truncate">
          {stop.stop_name || 'Unnamed Stop'}
        </span>
        {stop.stop_code && (
          <span className="text-[10px] text-warm-gray">Code: {stop.stop_code}</span>
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className="text-coral hover:text-[#d4603a] text-[10px] font-semibold shrink-0 opacity-0 group-hover:opacity-100 transition-opacity px-1"
        title="Edit stop properties"
      >
        Edit
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="text-warm-gray hover:text-red-500 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity px-0.5"
        title="Remove from route"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Per-route stop assignment editor. Lives under the "Stops" tab of a route's
 * detail panel. Lets the user pick a direction, place stops along the route
 * (snap-to-route or freehand), add an existing stop to this direction, and
 * drag-reorder the list. Stop *properties* (name, lat/lng, wheelchair, etc.)
 * are edited from the global Stops panel — this tab is concerned only with
 * which stops belong to this route and in what order.
 */
export function RouteStopsTab() {
  const routeId = useStore((s) => s.editingRouteId);
  const route = useStore((s) => s.routes.find((r) => r.route_id === routeId));
  const routes = useStore((s) => s.routes);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const stopTimes = useStore((s) => s.stopTimes);
  const trips = useStore((s) => s.trips);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectStop = useStore((s) => s.selectStop);
  const addRouteStop = useStore((s) => s.addRouteStop);
  const removeRouteStop = useStore((s) => s.removeRouteStop);
  const reorderRouteStops = useStore((s) => s.reorderRouteStops);
  const removeStop = useStore((s) => s.removeStop);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const setCreatingStop = useStore((s) => s.setCreatingStop);
  const directionId = useStore((s) => s.stopPlacementDirection);
  const setDirectionId = useStore((s) => s.setStopPlacementDirection);

  // Distinct shape patterns for this route. At 3+, the two-way Direction
  // toggle can't represent them, so we swap in the shared pattern dropdown
  // (matches the Timetable tab). Picking a pattern sets its direction — route
  // stops are stored per direction, so same-direction variants share a list.
  const patterns = useMemo(() => computeShapePatterns(routeId, trips), [routeId, trips]);
  const [selectedPatternShapeId, setSelectedPatternShapeId] = useState<string | null>(null);
  // Ignore a selection that isn't in the current route's patterns (e.g. left
  // over from another route) — fall back to the pattern for the active
  // direction. Avoids resetting state in an effect.
  const effectiveShapeId =
    selectedPatternShapeId && patterns.some((p) => p.shapeId === selectedPatternShapeId)
      ? selectedPatternShapeId
      : (patterns.find((p) => p.directionId === directionId)?.shapeId ?? null);

  const [addExistingStopId, setAddExistingStopId] = useState<string>('');
  const [confirmRemoveStop, setConfirmRemoveStop] = useState<{ stopId: string } | null>(null);
  // 'unassigned' (default) | 'all' | 'route:<id>'
  const [assignmentFilter, setAssignmentFilter] = useState<string>('unassigned');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const orderedRouteStops = useMemo(() => {
    if (!routeId) return [];
    return routeStops
      .filter((rs) => rs.route_id === routeId && rs.direction_id === directionId)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
  }, [routeId, routeStops, directionId]);

  const directionStops = useMemo(() => {
    return orderedRouteStops
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as Stop[];
  }, [orderedRouteStops, stops]);

  // Click on a stop row: select it, fly the map to it. Clicking the
  // already-selected row deselects (so the active state is dismissable in
  // place).
  const handleSelect = useCallback((stopId: string) => {
    const next = selectedStopId === stopId ? null : stopId;
    selectStop(next);
    if (next === null) return;
    const stop = stops.find((s) => s.stop_id === stopId);
    const flyTo = (window as { __mapFlyTo?: (lng: number, lat: number) => void }).__mapFlyTo;
    if (stop && flyTo) flyTo(stop.stop_lon, stop.stop_lat);
  }, [stops, selectStop, selectedStopId]);

  if (!routeId || !route) return null;

  const routeColor = `#${route.route_color}`;
  const stopIds = directionStops.map((s) => s.stop_id);

  const handleDragEnd = (event: DragEndEvent) => {
    // Safari (and some other browsers) fire a synthetic `click` on the
    // pointerup target after a pointermove drag. Without intercepting it,
    // the click lands on whichever row was under the cursor at drop time
    // and selects it. Eat exactly one click in the capture phase right
    // after dragEnd. `once: true` ensures the eater self-removes after the
    // first click, so the user's deliberate next click (always >> 0 ms
    // after the synthetic one) goes through normally. The setTimeout
    // cleanup handles browsers that DON'T fire the synthetic click — we
    // don't want a stale listener swallowing the next real click.
    const eatClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener('click', eatClick, { capture: true, once: true });
    window.setTimeout(() => {
      document.removeEventListener('click', eatClick, true);
    }, 0);

    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedRouteStops.findIndex((rs) => rs.stop_id === active.id);
    const newIndex = orderedRouteStops.findIndex((rs) => rs.stop_id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = orderedRouteStops.map((rs) => rs.stop_id);
    const [moved] = newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, moved);
    reorderRouteStops(routeId, directionId, newOrder);
  };

  // Stops already assigned to this route+direction — always exclude from the
  // "Add existing" pool so the dropdown doesn't offer to add a duplicate.
  const routeStopIdsThisDir = new Set(
    routeStops
      .filter((rs) => rs.route_id === routeId && rs.direction_id === directionId)
      .map((rs) => rs.stop_id),
  );

  // Build the assignment-filtered candidate set for the "Add existing" dropdown.
  // 'unassigned'      → stops not assigned to ANY route via route_stops.
  // 'route:<id>'      → stops on a specific OTHER route (any direction).
  // 'same-route-other-dir' → stops on the SAME route's other direction.
  //   Common case: user just split outbound into outbound + inbound and
  //   wants to grab the outbound's stops to populate the inbound side.
  // 'all'             → every stop in the feed.
  const assignedAnywhere = new Set(routeStops.map((rs) => rs.stop_id));
  const stopsOnRoute = (rid: string, dir?: 0 | 1) => new Set(
    routeStops
      .filter((rs) => rs.route_id === rid && (dir == null || rs.direction_id === dir))
      .map((rs) => rs.stop_id),
  );
  const oppositeDirection: 0 | 1 = directionId === 0 ? 1 : 0;
  const filterSet: ((sid: string) => boolean) = (() => {
    if (assignmentFilter === 'all') return () => true;
    if (assignmentFilter === 'unassigned') return (sid: string) => !assignedAnywhere.has(sid);
    if (assignmentFilter === 'same-route-other-dir') {
      const ids = stopsOnRoute(routeId, oppositeDirection);
      return (sid: string) => ids.has(sid);
    }
    if (assignmentFilter.startsWith('route:')) {
      const otherId = assignmentFilter.slice('route:'.length);
      const ids = stopsOnRoute(otherId);
      return (sid: string) => ids.has(sid);
    }
    return () => true;
  })();
  const availableStops = stops
    .filter((s) => !routeStopIdsThisDir.has(s.stop_id) && filterSet(s.stop_id))
    .sort((a, b) => (a.stop_name || a.stop_id).localeCompare(b.stop_name || b.stop_id));

  return (
    <div>
      {/* Direction selector — a 2-way toggle for 0–2 shape patterns, a
          dropdown for 3+ (which the toggle can't represent). */}
      <div className="mb-3">
        {patterns.length >= 3 ? (
          <PatternSelector
            patterns={patterns}
            route={route}
            selectedShapeId={effectiveShapeId}
            onChange={(p) => {
              setSelectedPatternShapeId(p.shapeId);
              if (p.directionId !== directionId) setDirectionId(p.directionId);
            }}
            className="w-full px-2 py-1.5 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
          />
        ) : (
          <div className="flex rounded-md border border-sand overflow-hidden">
            <button
              onClick={() => setDirectionId(0)}
              className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors
                ${directionId === 0 ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}`}
            >
              {directionName(route, 0)}
            </button>
            <button
              onClick={() => setDirectionId(1)}
              className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors border-l border-sand
                ${directionId === 1 ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}`}
            >
              {directionName(route, 1)}
            </button>
          </div>
        )}
      </div>

      {/* Add stops to this route+direction */}
      <div className="mb-3 space-y-2">
        <button
          onClick={() => setCreatingStop(true)}
          className="w-full px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors"
        >
          + Create new stop
        </button>

        {/* Filter the "Add existing" pool by current assignment so the dropdown
            isn't 1000+ stops long for big feeds. */}
        <div>
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Show stops from
          </label>
          <select
            value={assignmentFilter}
            onChange={(e) => { setAssignmentFilter(e.target.value); setAddExistingStopId(''); }}
            className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
          >
            <option value="unassigned">Unassigned stops</option>
            <option value="all">All stops</option>
            <option value="same-route-other-dir">
              This route — {directionName(route, oppositeDirection)} direction
            </option>
            {routes.filter((r) => r.route_id !== routeId).map((r) => (
              <option key={r.route_id} value={`route:${r.route_id}`}>
                {r.route_short_name || r.route_long_name || 'Untitled Route'}
              </option>
            ))}
          </select>
        </div>

        {availableStops.length > 0 ? (
          <div className="flex gap-1">
            <select
              value={addExistingStopId}
              onChange={(e) => setAddExistingStopId(e.target.value)}
              className="flex-1 px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral min-w-0"
            >
              <option value="">Add existing stop...</option>
              {availableStops.map((s) => (
                <option key={s.stop_id} value={s.stop_id}>
                  {s.stop_name || s.stop_id}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (!addExistingStopId) return;
                addRouteStop({
                  route_id: routeId,
                  stop_id: addExistingStopId,
                  direction_id: directionId,
                  stop_sequence: orderedRouteStops.length,
                  _snapped: false,
                });
                handleSelect(addExistingStopId);
                setAddExistingStopId('');
              }}
              disabled={!addExistingStopId}
              className="px-3 py-1.5 bg-coral text-white rounded-lg text-xs font-bold hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              Add
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-warm-gray italic">No stops match this filter.</p>
        )}
      </div>

      {/* Stop list */}
      {directionStops.length === 0 ? (
        <EmptyState
          icon="🚏"
          title="No stops in this direction"
          description="Use 'Create new stop' to place a new stop on the map, or pick one from the dropdown above."
        />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Stops ({directionStops.length})
            </span>
            <span className="text-[10px] text-warm-gray">Drag to reorder</span>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            // The stops list lives in an overflow-y-auto panel; the default
            // WhileDragging measuring caches droppable rects at drag-start, so
            // when the panel auto-scrolls mid-drag the drop lands offset by the
            // scroll amount. Re-measure on every move to keep collisions exact.
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          >
            <SortableContext items={stopIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-0.5">
                {directionStops.map((stop, i) => (
                  <SortableStopItem
                    key={stop.stop_id}
                    stop={stop}
                    index={i}
                    isSelected={selectedStopId === stop.stop_id}
                    routeColor={routeColor}
                    onSelect={() => handleSelect(stop.stop_id)}
                    onEdit={() => {
                      // Hand off to the global stop-edit sub-panel. RightRail's
                      // breadcrumb shows Routes › {route} › Stops because
                      // editingRouteId is still set and section is "routes".
                      selectStop(stop.stop_id);
                      setEditingStopId(stop.stop_id);
                    }}
                    onRemove={() => {
                      const otherUses = routeStops.filter(
                        (rs) => rs.stop_id === stop.stop_id
                          && !(rs.route_id === routeId && rs.direction_id === directionId),
                      );
                      const hasStopTimes = stopTimes.some((st) => st.stop_id === stop.stop_id);
                      const isOrphaned = otherUses.length === 0 && !hasStopTimes;
                      if (isOrphaned) {
                        setConfirmRemoveStop({ stopId: stop.stop_id });
                      } else {
                        removeRouteStop(routeId, stop.stop_id, directionId);
                      }
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* Confirm remove (only when removing the stop would orphan it) */}
      {confirmRemoveStop && (() => {
        const stop = stops.find((s) => s.stop_id === confirmRemoveStop.stopId);
        const stopName = stop?.stop_name || confirmRemoveStop.stopId;
        return (
          <div className="fixed inset-0 flex items-center justify-center z-50">
            <div className="absolute inset-0 bg-black/20" onClick={() => setConfirmRemoveStop(null)} />
            <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-xs mx-4">
              <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
                Remove "{stopName}"?
              </h3>
              <p className="text-sm text-warm-gray mb-4">
                This stop is not used by any other route. Remove it from this route only, or delete it entirely from the feed?
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    removeRouteStop(routeId, confirmRemoveStop.stopId, directionId);
                    setConfirmRemoveStop(null);
                  }}
                  className="w-full px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
                >
                  Remove from route only
                </button>
                <button
                  onClick={() => {
                    removeStop(confirmRemoveStop.stopId);
                    if (selectedStopId === confirmRemoveStop.stopId) selectStop(null);
                    setConfirmRemoveStop(null);
                  }}
                  className="w-full px-3 py-2 bg-red-500 text-white rounded-lg font-heading font-bold text-sm hover:bg-red-600 transition-colors"
                >
                  Delete stop entirely
                </button>
                <button
                  onClick={() => setConfirmRemoveStop(null)}
                  className="w-full px-3 py-1.5 text-xs text-warm-gray hover:text-dark-brown"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
