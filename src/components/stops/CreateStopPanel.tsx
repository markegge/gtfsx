import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES } from '../../utils/constants';
import { generateId } from '../../services/idGenerator';

/**
 * Create-new-stop sub-panel. Reachable from a "Create new stop" button in
 * either the Routes › Stops tab or the global Stops panel. Offers two paths:
 *
 *   1. Pick a placement mode (Snap to Route / Freehand), hit "Place on Map",
 *      then click the map. The MapView place_stop handler creates the stop
 *      and (if we have a route context) adds it to the active route+direction.
 *   2. Fill the form fields directly (name, lat/lng, etc.) and hit "Create".
 *      Useful when the lat/lng comes from a data import or a known address.
 *
 * Either way, after creation the panel switches to editing the new stop so
 * the user can fine-tune the properties without leaving the flow.
 */
export function CreateStopPanel() {
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const editingRouteId = useStore((s) => s.editingRouteId);
  const editingRoute = useStore((s) =>
    editingRouteId ? s.routes.find((r) => r.route_id === editingRouteId) : null,
  );
  const directionId = useStore((s) => s.stopPlacementDirection);
  const stopPlacementMode = useStore((s) => s.stopPlacementMode);
  const setStopPlacementMode = useStore((s) => s.setStopPlacementMode);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);
  const selectRoute = useStore((s) => s.selectRoute);
  const addStop = useStore((s) => s.addStop);
  const addRouteStop = useStore((s) => s.addRouteStop);
  const setCreatingStop = useStore((s) => s.setCreatingStop);
  const setEditingStopId = useStore((s) => s.setEditingStopId);

  const fromRouteContext = !!editingRouteId && !!editingRoute;

  // Make sure the place_stop handler in MapView reads the editing route as
  // the active route while this panel is open — otherwise the snap target
  // and route_stop assignment would be wrong for routes that aren't also
  // the "selected" one.
  if (fromRouteContext && useStore.getState().selectedRouteId !== editingRouteId) {
    selectRoute(editingRouteId);
  }

  // Form for manual entry. Defaults to empty; lat/lng are required to create.
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [wheelchair, setWheelchair] = useState(0);
  const [locationType, setLocationType] = useState(0);

  const placingOnMap = mapMode === 'place_stop';
  const canCreate = !!lat && !!lon && !isNaN(Number(lat)) && !isNaN(Number(lon));

  const togglePlaceOnMap = () => {
    setMapMode(placingOnMap ? 'select' : 'place_stop');
  };

  const handleCreate = () => {
    if (!canCreate) return;
    const id = generateId('stop');
    addStop({
      stop_id: id,
      stop_name: name || `Stop ${stops.length + 1}`,
      stop_code: code || undefined,
      stop_lat: Number(lat),
      stop_lon: Number(lon),
      location_type: locationType,
      wheelchair_boarding: wheelchair,
    });
    if (fromRouteContext && editingRouteId) {
      const existing = routeStops.filter(
        (rs) => rs.route_id === editingRouteId && rs.direction_id === directionId,
      );
      addRouteStop({
        route_id: editingRouteId,
        stop_id: id,
        direction_id: directionId,
        stop_sequence: existing.length,
        _snapped: false,
      });
    }
    // Hand off to the edit sub-panel so the user can refine details — the
    // CreateStopPanel only handles the initial create gesture.
    setCreatingStop(false);
    setEditingStopId(id);
  };

  return (
    <div>
      {fromRouteContext && (
        <p className="mb-3 text-xs text-warm-gray">
          New stop will be added to {editingRoute?.route_short_name || editingRoute?.route_long_name || 'this route'} in the current direction.
        </p>
      )}

      {/* Map placement */}
      <div className="mb-4">
        <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1.5">
          Place on map
        </div>
        {fromRouteContext && (
          <div className="flex gap-1 bg-sand rounded-lg p-0.5 mb-2">
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
        )}
        <button
          onClick={togglePlaceOnMap}
          className={`w-full px-4 py-2 rounded-lg font-heading font-bold text-sm transition-colors
            ${placingOnMap
              ? 'bg-coral text-white'
              : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
            }`}
        >
          {placingOnMap ? 'Done placing — click map to drop pin' : 'Place on Map'}
        </button>
        <p className="mt-1.5 text-[11px] text-warm-gray">
          Click anywhere on the map to drop a new stop. {fromRouteContext
            ? 'It will be added to this route automatically.'
            : 'Then refine its properties.'}
        </p>
      </div>

      {/* Manual entry */}
      <div className="border-t border-sand pt-3">
        <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1.5">
          Or enter manually
        </div>
        <FormField label="Stop Name" value={name} onChange={setName} placeholder="e.g., Main St & 1st Ave" />
        <FormField label="Stop Code" value={code} onChange={setCode} placeholder="Rider-facing code" />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Latitude" value={lat} onChange={setLat} placeholder="45.6770" type="number" required />
          <FormField label="Longitude" value={lon} onChange={setLon} placeholder="-111.0429" type="number" required />
        </div>

        <FormField label="Wheelchair Boarding">
          <select
            value={wheelchair}
            onChange={(e) => setWheelchair(Number(e.target.value))}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
          >
            {Object.entries(WHEELCHAIR_BOARDING).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </FormField>

        <FormField label="Location Type">
          <select
            value={locationType}
            onChange={(e) => setLocationType(Number(e.target.value))}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
          >
            {Object.entries(LOCATION_TYPES).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </FormField>

        <button
          onClick={handleCreate}
          disabled={!canCreate}
          className="w-full px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {fromRouteContext ? 'Create & add to route' : 'Create stop'}
        </button>
      </div>
    </div>
  );
}
