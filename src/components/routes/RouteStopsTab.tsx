import { useState, useMemo, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
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
    transition,
    isDragging,
  } = useSortable({ id: stop.stop_id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
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
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const stopTimes = useStore((s) => s.stopTimes);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectStop = useStore((s) => s.selectStop);
  const addRouteStop = useStore((s) => s.addRouteStop);
  const removeRouteStop = useStore((s) => s.removeRouteStop);
  const reorderRouteStops = useStore((s) => s.reorderRouteStops);
  const removeStop = useStore((s) => s.removeStop);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);
  const stopPlacementMode = useStore((s) => s.stopPlacementMode);
  const setStopPlacementMode = useStore((s) => s.setStopPlacementMode);
  const directionId = useStore((s) => s.stopPlacementDirection);
  const setDirectionId = useStore((s) => s.setStopPlacementDirection);

  const [addExistingStopId, setAddExistingStopId] = useState<string>('');
  const [confirmRemoveStop, setConfirmRemoveStop] = useState<{ stopId: string } | null>(null);

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

  if (!routeId || !route) return null;

  const routeColor = `#${route.route_color}`;
  const stopIds = directionStops.map((s) => s.stop_id);

  const handleDragEnd = (event: DragEndEvent) => {
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

  const handleSelect = useCallback((stopId: string) => {
    selectStop(stopId);
    const stop = stops.find((s) => s.stop_id === stopId);
    const flyTo = (window as { __mapFlyTo?: (lng: number, lat: number) => void }).__mapFlyTo;
    if (stop && flyTo) flyTo(stop.stop_lon, stop.stop_lat);
  }, [stops, selectStop]);

  const routeStopIdsThisDir = new Set(
    routeStops
      .filter((rs) => rs.route_id === routeId && rs.direction_id === directionId)
      .map((rs) => rs.stop_id),
  );
  const availableStops = stops
    .filter((s) => !routeStopIdsThisDir.has(s.stop_id))
    .sort((a, b) => (a.stop_name || a.stop_id).localeCompare(b.stop_name || b.stop_id));

  return (
    <div>
      {/* Direction toggle */}
      <div className="mb-3">
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
      </div>

      {/* Placement mode */}
      <div className="mb-3">
        <div className="flex gap-1 bg-sand rounded-lg p-0.5">
          <button
            onClick={() => setStopPlacementMode('snap_to_route')}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors
              ${stopPlacementMode === 'snap_to_route' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray'}`}
          >
            Snap to Route
          </button>
          <button
            onClick={() => setStopPlacementMode('freehand')}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors
              ${stopPlacementMode === 'freehand' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray'}`}
          >
            Freehand
          </button>
        </div>
        <button
          onClick={() => setMapMode(mapMode === 'place_stop' ? 'select' : 'place_stop')}
          className={`w-full mt-2 px-4 py-2 rounded-lg font-heading font-bold text-sm transition-colors
            ${mapMode === 'place_stop'
              ? 'bg-coral text-white'
              : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
            }`}
        >
          {mapMode === 'place_stop' ? 'Done Placing Stops' : 'Place Stops on Map'}
        </button>

        {availableStops.length > 0 && (
          <div className="mt-2 flex gap-1">
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
        )}
      </div>

      {/* Stop list */}
      {directionStops.length === 0 ? (
        <EmptyState
          icon="🚏"
          title="No stops in this direction"
          description="Click 'Place Stops on Map' to drop stops along this route, or add an existing stop above."
        />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Stops ({directionStops.length})
            </span>
            <span className="text-[10px] text-warm-gray">Drag to reorder</span>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
                      handleSelect(stop.stop_id);
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
