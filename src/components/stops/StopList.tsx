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
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES, directionName } from '../../utils/constants';
import type { Stop } from '../../types/gtfs';

function SortableStopItem({
  stop,
  index,
  isSelected,
  routeColor,
  onSelect,
  onRemove,
}: {
  stop: Stop;
  index: number;
  isSelected: boolean;
  routeColor: string;
  onSelect: () => void;
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
      {/* Drag handle */}
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
        style={{
          borderColor: routeColor,
          backgroundColor: isSelected ? routeColor : 'white',
        }}
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
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="text-warm-gray hover:text-red-500 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity px-0.5"
        title="Remove from route"
      >
        ×
      </button>
    </div>
  );
}

export function StopList() {
  const {
    stops, updateStop, removeStop, stopTimes,
    routes, routeStops, reorderRouteStops, addRouteStop, removeRouteStop,
    selectedRouteId, selectRoute,
    selectedStopId, selectStop,
    mapMode, setMapMode, stopPlacementMode, setStopPlacementMode,
    stopPlacementDirection, setStopPlacementDirection,
  } = useStore();

  const [addExistingStopId, setAddExistingStopId] = useState<string>('');
  const [confirmRemoveStop, setConfirmRemoveStop] = useState<{ stopId: string; isUnique: boolean } | null>(null);
  const directionId = stopPlacementDirection;
  const setDirectionId = setStopPlacementDirection;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedRoute = selectedRouteId ? routes.find((r) => r.route_id === selectedRouteId) : null;

  // Get ordered stop IDs for the selected route + selected direction
  const orderedRouteStops = useMemo(() => {
    if (!selectedRouteId) return [];
    return routeStops
      .filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === directionId)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
  }, [selectedRouteId, routeStops, directionId]);

  const routeFilteredStops = useMemo(() => {
    if (!selectedRouteId) return stops;
    return orderedRouteStops
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as Stop[];
  }, [selectedRouteId, orderedRouteStops, stops]);

  const selectedStop = selectedStopId ? stops.find((s) => s.stop_id === selectedStopId) : null;
  const routeColor = selectedRoute ? `#${selectedRoute.route_color}` : '#E8734A';

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedRouteId) return;

    const oldIndex = orderedRouteStops.findIndex((rs) => rs.stop_id === active.id);
    const newIndex = orderedRouteStops.findIndex((rs) => rs.stop_id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Build new order
    const newOrder = [...orderedRouteStops.map((rs) => rs.stop_id)];
    const [moved] = newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, moved);

    reorderRouteStops(selectedRouteId, directionId, newOrder);
  }, [selectedRouteId, directionId, orderedRouteStops, reorderRouteStops]);

  const handleSelectStop = useCallback((stopId: string) => {
    selectStop(stopId);
    const stop = stops.find((s) => s.stop_id === stopId);
    if (stop && (window as any).__mapFlyTo) {
      (window as any).__mapFlyTo(stop.stop_lon, stop.stop_lat);
    }
  }, [stops, selectStop]);

  const stopIds = useMemo(() => routeFilteredStops.map((s) => s.stop_id), [routeFilteredStops]);

  return (
    <div>
      {/* Route selector */}
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          For Route
        </label>
        <div className="flex items-center gap-2">
          {selectedRouteId && selectedRoute && (
            <span
              className="w-3.5 h-3.5 rounded shrink-0"
              style={{ background: `#${selectedRoute.route_color}` }}
              aria-hidden
            />
          )}
          <select
            value={selectedRouteId || ''}
            onChange={(e) => selectRoute(e.target.value || null)}
            className="flex-1 min-w-0 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
          >
            <option value="">All stops</option>
            {routes.map((r) => {
              const name = r.route_short_name || r.route_long_name;
              return (
                <option key={r.route_id} value={r.route_id}>
                  {name ? name : 'Untitled Route'}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {/* Direction toggle */}
      {selectedRouteId && (
        <div className="mb-3">
          <div className="flex rounded-md border border-sand overflow-hidden">
            <button
              onClick={() => setDirectionId(0)}
              className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors
                ${directionId === 0 ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}`}
            >
              {directionName(selectedRoute, 0)}
            </button>
            <button
              onClick={() => setDirectionId(1)}
              className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors border-l border-sand
                ${directionId === 1 ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}`}
            >
              {directionName(selectedRoute, 1)}
            </button>
          </div>
        </div>
      )}

      {/* Placement mode */}
      {selectedRouteId && (
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

          {/* Add existing stop to route */}
          {(() => {
            const routeStopIds = new Set(
              routeStops.filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === directionId).map((rs) => rs.stop_id),
            );
            const availableStops = stops.filter((s) => !routeStopIds.has(s.stop_id))
              .sort((a, b) => (a.stop_name || a.stop_id).localeCompare(b.stop_name || b.stop_id));
            if (availableStops.length === 0) return null;

            return (
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
                    if (!addExistingStopId || !selectedRouteId) return;
                    const existing = routeStops.filter(
                      (rs) => rs.route_id === selectedRouteId && rs.direction_id === directionId,
                    );
                    addRouteStop({
                      route_id: selectedRouteId,
                      stop_id: addExistingStopId,
                      direction_id: directionId,
                      stop_sequence: existing.length,
                      _snapped: false,
                    });
                    handleSelectStop(addExistingStopId);
                    setAddExistingStopId('');
                  }}
                  disabled={!addExistingStopId}
                  className="px-3 py-1.5 bg-coral text-white rounded-lg text-xs font-bold hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  Add
                </button>
              </div>
            );
          })()}
        </div>
      )}

      {/* Stop list */}
      {routeFilteredStops.length === 0 ? (
        <EmptyState
          icon="🚏"
          title="No stops yet"
          description={selectedRouteId
            ? "Click 'Place Stops on Map' to add stops along this route."
            : "Select a route first, then add stops along it."
          }
        />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Stops ({routeFilteredStops.length})
            </span>
            {selectedRouteId && (
              <span className="text-[10px] text-warm-gray">Drag to reorder</span>
            )}
          </div>

          {selectedRouteId ? (
            /* Sortable list for route-specific stops */
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={stopIds} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-0.5">
                  {routeFilteredStops.map((stop, i) => (
                    <SortableStopItem
                      key={stop.stop_id}
                      stop={stop}
                      index={i}
                      isSelected={selectedStopId === stop.stop_id}
                      routeColor={routeColor}
                      onSelect={() => handleSelectStop(stop.stop_id)}
                      onRemove={() => {
                        // Check if this stop is used elsewhere (other routes, other direction, or stop_times)
                        const otherRouteStopUses = routeStops.filter(
                          (rs) => rs.stop_id === stop.stop_id
                            && !(rs.route_id === selectedRouteId && rs.direction_id === directionId),
                        );
                        const hasStopTimeUses = stopTimes.some((st) => st.stop_id === stop.stop_id);
                        const isOrphaned = otherRouteStopUses.length === 0 && !hasStopTimeUses;
                        if (isOrphaned) {
                          setConfirmRemoveStop({ stopId: stop.stop_id, isUnique: true });
                        } else {
                          // Used elsewhere — just remove from this route/direction
                          removeRouteStop(selectedRouteId!, stop.stop_id, directionId);
                        }
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            /* Non-sortable list for all stops */
            <div className="flex flex-col gap-0.5">
              {routeFilteredStops.map((stop, i) => (
                <button
                  key={stop.stop_id}
                  onClick={() => handleSelectStop(stop.stop_id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left
                    ${selectedStopId === stop.stop_id ? 'bg-sand' : 'hover:bg-cream'}`}
                >
                  <span className="text-warm-gray text-[11px] w-4 text-right shrink-0">{i + 1}</span>
                  <div
                    className="w-2.5 h-2.5 rounded-full border-2 shrink-0"
                    style={{ borderColor: '#E8734A', backgroundColor: selectedStopId === stop.stop_id ? '#E8734A' : 'white' }}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-medium text-dark-brown truncate">
                      {stop.stop_name || 'Unnamed Stop'}
                    </span>
                    {stop.stop_code && (
                      <span className="text-[10px] text-warm-gray">Code: {stop.stop_code}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Selected stop editor */}
      {selectedStop && (
        <div className="mt-4 pt-4 border-t border-sand">
          <h4 id="stop-properties" className="font-heading font-bold text-sm text-dark-brown mb-3">Stop Properties</h4>
          <FormField
            label="Stop Name"
            value={selectedStop.stop_name}
            onChange={(v) => updateStop(selectedStop.stop_id, { stop_name: v })}
            placeholder="e.g., Main St & 1st Ave"
            required
          />
          <FormField
            label="Stop Code"
            value={selectedStop.stop_code || ''}
            onChange={(v) => updateStop(selectedStop.stop_id, { stop_code: v })}
            placeholder="Rider-facing code"
          />
          <FormField
            label="Description"
            value={selectedStop.stop_desc || ''}
            onChange={(v) => updateStop(selectedStop.stop_id, { stop_desc: v })}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Latitude"
              value={String(selectedStop.stop_lat)}
              onChange={(v) => updateStop(selectedStop.stop_id, { stop_lat: Number(v) })}
              type="number"
            />
            <FormField
              label="Longitude"
              value={String(selectedStop.stop_lon)}
              onChange={(v) => updateStop(selectedStop.stop_id, { stop_lon: Number(v) })}
              type="number"
            />
          </div>

          <button
            onClick={() => setMapMode(mapMode === 'move_stop' ? 'select' : 'move_stop')}
            className={`w-full mb-1 px-4 py-2 rounded-lg font-heading font-bold text-sm transition-colors
              ${mapMode === 'move_stop'
                ? 'bg-coral text-white hover:opacity-90'
                : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
              }`}
          >
            {mapMode === 'move_stop' ? '✓ Save Location' : 'Move Stop Location'}
          </button>
          {mapMode === 'move_stop' && (
            <p className="text-[11px] text-warm-gray mb-3 px-1">
              Drag the stop on the map, or click a new location. Your changes save automatically — press Save Location when you're done to exit move mode.
            </p>
          )}

          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Wheelchair Boarding
            </label>
            <select
              value={selectedStop.wheelchair_boarding}
              onChange={(e) => updateStop(selectedStop.stop_id, { wheelchair_boarding: Number(e.target.value) })}
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
            >
              {Object.entries(WHEELCHAIR_BOARDING).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Location Type
            </label>
            <select
              value={selectedStop.location_type}
              onChange={(e) => updateStop(selectedStop.stop_id, { location_type: Number(e.target.value) })}
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
            >
              {Object.entries(LOCATION_TYPES).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={() => {
              removeStop(selectedStop.stop_id);
              selectStop(null);
            }}
            className="text-xs text-red-400 hover:text-red-600"
          >
            Delete stop
          </button>
        </div>
      )}

      {/* Confirm remove stop from route */}
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
                This stop is not used by any other route. Would you like to delete it entirely, or just remove it from this route?
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    removeRouteStop(selectedRouteId!, confirmRemoveStop.stopId, directionId);
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
