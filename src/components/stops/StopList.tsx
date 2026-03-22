
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES } from '../../utils/constants';

export function StopList() {
  const {
    stops, updateStop, removeStop,
    routes, routeStops,
    selectedRouteId, selectRoute,
    selectedStopId, selectStop,
    mapMode, setMapMode, stopPlacementMode, setStopPlacementMode,
  } = useStore();

  // Filter stops for selected route, or show all
  const routeFilteredStops = selectedRouteId
    ? routeStops
        .filter((rs) => rs.route_id === selectedRouteId)
        .sort((a, b) => a.stop_sequence - b.stop_sequence)
        .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
        .filter(Boolean)
    : stops;

  const selectedStop = selectedStopId ? stops.find((s) => s.stop_id === selectedStopId) : null;
  const selectedRoute = selectedRouteId ? routes.find((r) => r.route_id === selectedRouteId) : null;

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
        <div className="flex flex-col gap-0.5">
          <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Stops ({routeFilteredStops.length})
          </div>
          {routeFilteredStops.map((stop, i) => (
            <button
              key={stop!.stop_id}
              onClick={() => selectStop(stop!.stop_id)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-left
                ${selectedStopId === stop!.stop_id ? 'bg-sand' : 'hover:bg-cream'}`}
            >
              <span className="text-warm-gray text-[11px] w-4 text-right shrink-0">{i + 1}</span>
              <div
                className="w-2.5 h-2.5 rounded-full border-2 shrink-0"
                style={{
                  borderColor: selectedRoute ? `#${selectedRoute.route_color}` : '#E8734A',
                  backgroundColor: selectedStopId === stop!.stop_id
                    ? (selectedRoute ? `#${selectedRoute.route_color}` : '#E8734A')
                    : 'white',
                }}
              />
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-dark-brown truncate">
                  {stop!.stop_name || 'Unnamed Stop'}
                </span>
                {stop!.stop_code && (
                  <span className="text-[10px] text-warm-gray">Code: {stop!.stop_code}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Selected stop editor */}
      {selectedStop && (
        <div className="mt-4 pt-4 border-t border-sand">
          <h4 className="font-heading font-bold text-sm text-dark-brown mb-3">Stop Properties</h4>
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
