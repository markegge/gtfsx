import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES, COMMON_STOP_TIMEZONES } from '../../utils/constants';
import { StopDeparturesSection } from './StopDeparturesSection';
import { StopCoveragePanel } from './StopCoveragePanel';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';

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
  const levels = useStore((s) => s.levels);
  const updateStop = useStore((s) => s.updateStop);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);
  const shapes = useStore((s) => s.shapes);
  const tab = useStore((s) => s.stopDetailTab);
  const plan = useEditorPlan();

  if (!stop) return null;

  // Trips tab: just the per-stop schedule (header tabs switch between this and
  // the editable details below).
  if (tab === 'trips') return <StopDeparturesSection />;

  // Coverage tab: per-stop adjacency + demographic metrics. Gated by the same
  // analysis_basic feature as the system Coverage panel — same data source,
  // same paid-plan check.
  if (tab === 'coverage') {
    return (
      <PaywallOverlay feature="analysis_basic" currentPlan={plan}>
        <StopCoveragePanel />
      </PaywallOverlay>
    );
  }

  // Snap the stop onto the nearest point of any route shape — the stop-editing
  // analogue of "snap to road" when drawing a shape.
  const snapToNearestShape = () => {
    const p = point([stop.stop_lon, stop.stop_lat]);
    let bestCoord: [number, number] | null = null;
    let bestDist = Infinity;
    for (const sh of shapes) {
      if (sh.points.length < 2) continue;
      const line = lineString(sh.points.map((pt) => [pt.shape_pt_lon, pt.shape_pt_lat] as [number, number]));
      const snapped = nearestPointOnLine(line, p, { units: 'meters' });
      const d = snapped.properties.dist ?? Infinity;
      if (d < bestDist) {
        bestDist = d;
        bestCoord = snapped.geometry.coordinates as [number, number];
      }
    }
    if (bestCoord) {
      updateStop(stop.stop_id, {
        stop_lon: Math.round(bestCoord[0] * 1e6) / 1e6,
        stop_lat: Math.round(bestCoord[1] * 1e6) / 1e6,
      });
    }
  };

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
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          Stop Location
        </label>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <FormField label="Latitude" size="sub" containerClassName="">
            <input
              type="number"
              value={String(stop.stop_lat)}
              onChange={(e) => updateStop(stop.stop_id, { stop_lat: Number(e.target.value) })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </FormField>
          <FormField label="Longitude" size="sub" containerClassName="">
            <input
              type="number"
              value={String(stop.stop_lon)}
              onChange={(e) => updateStop(stop.stop_id, { stop_lon: Number(e.target.value) })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </FormField>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setMapMode(mapMode === 'move_stop' ? 'select' : 'move_stop')}
            className={`flex-1 px-3 py-2 rounded-lg font-heading font-bold text-sm border-2 transition-colors flex items-center justify-center gap-1.5
              ${mapMode === 'move_stop'
                ? 'bg-coral text-white border-coral hover:opacity-90'
                : 'bg-white text-coral border-coral hover:bg-coral-light'
              }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="12" cy="12" r="7" />
              <line x1="12" y1="1" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="23" />
              <line x1="1" y1="12" x2="4" y2="12" />
              <line x1="20" y1="12" x2="23" y2="12" />
            </svg>
            {mapMode === 'move_stop' ? 'Save Location' : 'Move Stop'}
          </button>
          <button
            onClick={snapToNearestShape}
            title="Snap this stop onto the nearest route shape"
            className="px-3 py-2 rounded-lg font-heading font-bold text-sm border-2 border-sand bg-white text-warm-gray hover:border-coral hover:text-coral transition-colors"
          >
            Snap
          </button>
        </div>
        {mapMode === 'move_stop' && (
          <p className="text-[11px] text-warm-gray mt-1.5 px-1">
            Drag the stop on the map, or click a new location. Changes save automatically — press Save Location when done.
          </p>
        )}
      </div>

      <FormField label="Wheelchair Boarding">
        <select
          value={stop.wheelchair_boarding}
          onChange={(e) => updateStop(stop.stop_id, { wheelchair_boarding: Number(e.target.value) })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          {Object.entries(WHEELCHAIR_BOARDING).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </FormField>

      <FormField label="Location Type">
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
      </FormField>

      {canHaveParent && (
        <FormField label="Parent Station">
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
        </FormField>
      )}

      <FormField label="Level">
        <select
          value={stop.level_id || ''}
          onChange={(e) => updateStop(stop.stop_id, { level_id: e.target.value || undefined })}
          disabled={levels.length === 0}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral disabled:opacity-50"
        >
          <option value="">— None —</option>
          {levels.map((l) => (
            <option key={l.level_id} value={l.level_id}>
              {l.level_name ? `${l.level_name} (${l.level_index})` : `${l.level_id} (${l.level_index})`}
            </option>
          ))}
        </select>
        {levels.length === 0 && (
          <p className="text-[11px] text-warm-gray mt-1">
            Define levels in the Stations panel to place this stop on a floor (for multi-level stations with pathways).
          </p>
        )}
      </FormField>

      <FormField label="Stop Timezone">
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
      </FormField>

      <FormField
        label="Fare Zone ID"
        value={stop.zone_id || ''}
        onChange={(v) => updateStop(stop.stop_id, { zone_id: v || undefined })}
        placeholder="e.g. zone-1, downtown, juneau"
      />
    </div>
  );
}
