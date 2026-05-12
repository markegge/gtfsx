import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES } from '../../utils/constants';

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
  const updateStop = useStore((s) => s.updateStop);
  const removeStop = useStore((s) => s.removeStop);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const selectStop = useStore((s) => s.selectStop);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);

  if (!stop) return null;

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
          onChange={(e) => updateStop(stop.stop_id, { location_type: Number(e.target.value) })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          {Object.entries(LOCATION_TYPES).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

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
    </div>
  );
}
