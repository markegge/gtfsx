import { useMemo, useCallback } from 'react';
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
import { WHEELCHAIR_BOARDING, LOCATION_TYPES } from '../../utils/constants';
import type { Stop } from '../../types/gtfs';

function SortableStopItem({
  stop,
  index,
  isSelected,
  routeColor,
  onSelect,
}: {
  stop: Stop;
  index: number;
  isSelected: boolean;
  routeColor: string;
  onSelect: () => void;
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
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors
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
    </div>
  );
}

export function StopList() {
  const {
    stops, updateStop, removeStop,
    routes, routeStops, reorderRouteStops,
    selectedRouteId, selectRoute,
    selectedStopId, selectStop,
    mapMode, setMapMode, stopPlacementMode, setStopPlacementMode,
  } = useStore();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Get ordered stop IDs for the selected route + direction 0
  const orderedRouteStops = useMemo(() => {
    if (!selectedRouteId) return [];
    return routeStops
      .filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === 0)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
  }, [selectedRouteId, routeStops]);

  const routeFilteredStops = useMemo(() => {
    if (!selectedRouteId) return stops;
    return orderedRouteStops
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as Stop[];
  }, [selectedRouteId, orderedRouteStops, stops]);

  const selectedStop = selectedStopId ? stops.find((s) => s.stop_id === selectedStopId) : null;
  const selectedRoute = selectedRouteId ? routes.find((r) => r.route_id === selectedRouteId) : null;
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

    reorderRouteStops(selectedRouteId, 0, newOrder);
  }, [selectedRouteId, orderedRouteStops, reorderRouteStops]);

  const stopIds = useMemo(() => routeFilteredStops.map((s) => s.stop_id), [routeFilteredStops]);

  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-2">Stops</h3>

      {/* Route selector */}
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          For Route
        </label>
        <select
          value={selectedRouteId || ''}
          onChange={(e) => selectRoute(e.target.value || null)}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          <option value="">All stops</option>
          {routes.map((r) => (
            <option key={r.route_id} value={r.route_id}>
              {r.route_short_name || r.route_long_name || r.route_id}
            </option>
          ))}
        </select>
      </div>

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
                      onSelect={() => selectStop(stop.stop_id)}
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
                  onClick={() => selectStop(stop.stop_id)}
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
    </div>
  );
}
