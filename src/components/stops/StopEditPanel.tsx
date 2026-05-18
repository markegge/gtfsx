import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES, COMMON_STOP_TIMEZONES } from '../../utils/constants';
import { StopDeparturesSection } from './StopDeparturesSection';

/**
 * Stop edit sub-panel. Rendered by RightRail when `editingStopId` is set;
 * the breadcrumb is provided by the container so it can show either
 * `Stops > Stop X` (when entered from the Stops panel) or
 * `Routes > {route} > Stop X` (when entered from a route's Stops tab).
 */
export function StopEditPanel() {
  const editingStopId = useStore((s) => s.editingStopId);
  const stop = useStore((s) =>
    editingStopId ? s.stops.find((x) => x.stop_id === editingStopId) : null,
  );
  const allStops = useStore((s) => s.stops);
  const updateStop = useStore((s) => s.updateStop);
  const removeStop = useStore((s) => s.removeStop);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const selectStop = useStore((s) => s.selectStop);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);

  if (!stop) return null;

  // parent_station can only be set on non-station stops, and only points to
  // location_type=1 stations. Filter the candidate list accordingly.
  const stationOptions = allStops
    .filter((s) => s.location_type === 1 && s.stop_id !== stop.stop_id)
    .sort((a, b) => a.stop_name.localeCompare(b.stop_name));
  const canHaveParent = stop.location_type !== 1;

  return (
    <div>
      <FormField
        label="Stop Name"
        value={stop.stop_name}
        onChange={(v) => updateStop(stop.stop_id, { stop_name: v })}
        placeholder="e.g., Main St & 1st Ave"
        required
      />
      <FormField
        label="Stop Code"
        value={stop.stop_code || ''}
        onChange={(v) => updateStop(stop.stop_id, { stop_code: v })}
        placeholder="Rider-facing code"
      />
      <FormField
        label="Description"
        value={stop.stop_desc || ''}
        onChange={(v) => updateStop(stop.stop_id, { stop_desc: v })}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormField
          label="Latitude"
          value={String(stop.stop_lat)}
          onChange={(v) => updateStop(stop.stop_id, { stop_lat: Number(v) })}
          type="number"
        />
        <FormField
          label="Longitude"
          value={String(stop.stop_lon)}
          onChange={(v) => updateStop(stop.stop_id, { stop_lon: Number(v) })}
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
          Drag the stop on the map, or click a new location. Your changes save automatically — press Save Location when you're done.
        </p>
      )}

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Wheelchair Boarding
        </label>
        <select
          value={stop.wheelchair_boarding}
          onChange={(e) => updateStop(stop.stop_id, { wheelchair_boarding: Number(e.target.value) })}
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
          value={stop.location_type}
          onChange={(e) => {
            const newType = Number(e.target.value);
            const updates: Partial<typeof stop> = { location_type: newType };
            // Stations cannot have a parent_station — clear it if the user
            // upgrades a child stop to a station.
            if (newType === 1 && stop.parent_station) updates.parent_station = undefined;
            updateStop(stop.stop_id, updates);
          }}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          {Object.entries(LOCATION_TYPES).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

      {canHaveParent && (
        <div className="mb-3">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Parent Station
          </label>
          <select
            value={stop.parent_station || ''}
            onChange={(e) => updateStop(stop.stop_id, { parent_station: e.target.value || undefined })}
            disabled={stationOptions.length === 0}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral disabled:opacity-50"
          >
            <option value="">— None —</option>
            {stationOptions.map((s) => (
              <option key={s.stop_id} value={s.stop_id}>
                {s.stop_name || s.stop_id}
              </option>
            ))}
          </select>
          {stationOptions.length === 0 && (
            <p className="text-[11px] text-warm-gray mt-1">
              Create a stop with Location Type "Station" to link this stop to it.
            </p>
          )}
        </div>
      )}

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Stop Timezone
        </label>
        <select
          value={stop.stop_timezone || ''}
          onChange={(e) => updateStop(stop.stop_id, { stop_timezone: e.target.value || undefined })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          {COMMON_STOP_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz || 'Inherit from agency'}</option>
          ))}
        </select>
        <p className="text-[11px] text-warm-gray mt-1">
          Override the agency timezone for this stop. Used by feeds that span multiple zones (e.g. ferries between Alaska and Pacific).
        </p>
      </div>

      <FormField
        label="Fare Zone ID"
        value={stop.zone_id || ''}
        onChange={(v) => updateStop(stop.stop_id, { zone_id: v || undefined })}
        placeholder="e.g. zone-1, downtown, juneau"
      />

      <button
        onClick={() => {
          removeStop(stop.stop_id);
          selectStop(null);
          setEditingStopId(null);
        }}
        className="text-xs text-red-400 hover:text-red-600"
      >
        Delete stop
      </button>

      <StopDeparturesSection />
    </div>
  );
}
