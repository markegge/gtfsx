import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { RailSubHeading, RailDivider } from '../ui/RailHeadings';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES } from '../../utils/constants';
export function RouteEditor() {
  const {
    routes, updateRoute,
    selectedRouteId,
  } = useStore();

  const route = routes.find((r) => r.route_id === selectedRouteId);
  if (!route) return null;

  return (
    <div>
      {/* Route properties */}
      <FormField
        label="Short Name"
        value={route.route_short_name}
        onChange={(v) => updateRoute(route.route_id, { route_short_name: v })}
        placeholder="e.g., Blueline"
        required
      />
      <FormField
        label="Long Name"
        value={route.route_long_name}
        onChange={(v) => updateRoute(route.route_id, { route_long_name: v })}
        placeholder="e.g., Main Street Express"
      />
      <FormField
        label="Description"
        value={route.route_desc || ''}
        onChange={(v) => updateRoute(route.route_id, { route_desc: v })}
        placeholder="Brief route description"
      />
      <FormField
        label="URL"
        value={route.route_url || ''}
        onChange={(v) => updateRoute(route.route_id, { route_url: v })}
        placeholder="https://..."
      />

      {/* Route Type */}
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Route Type
        </label>
        <select
          value={route.route_type}
          onChange={(e) => updateRoute(route.route_id, { route_type: Number(e.target.value) })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          {Object.entries(ROUTE_TYPES).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

      {/* Route Color */}
      <div className="mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Route Color
        </label>
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-lg"
            style={{ backgroundColor: `#${route.route_color}` }}
          />
          <input
            value={`#${route.route_color}`}
            onChange={(e) => {
              const hex = e.target.value.replace('#', '').toUpperCase();
              if (/^[0-9A-F]{6}$/.test(hex)) {
                updateRoute(route.route_id, {
                  route_color: hex,
                  route_text_color: getContrastTextColor(hex),
                });
              }
            }}
            className="w-24 px-2 py-1 border-2 border-sand rounded-lg text-sm font-mono bg-cream focus:outline-none focus:border-coral"
          />
        </div>
        <div className="grid grid-cols-8 gap-1.5">
          {ROUTE_COLORS.map((color) => (
            <button
              key={color}
              onClick={() => updateRoute(route.route_id, {
                route_color: color,
                route_text_color: getContrastTextColor(color),
              })}
              className={`w-7 h-7 rounded-md transition-transform hover:scale-110
                ${route.route_color === color ? 'ring-2 ring-dark-brown ring-offset-2' : ''}`}
              style={{ backgroundColor: `#${color}` }}
            />
          ))}
        </div>
      </div>

      {/* Direction Names */}
      <div className="mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          Direction Labels
        </label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Direction 0</label>
            <input
              value={route._direction_0_name || ''}
              onChange={(e) => updateRoute(route.route_id, { _direction_0_name: e.target.value })}
              placeholder="Outbound"
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </div>
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Direction 1</label>
            <input
              value={route._direction_1_name || ''}
              onChange={(e) => updateRoute(route.route_id, { _direction_1_name: e.target.value })}
              placeholder="Inbound"
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </div>
        </div>
      </div>

      {/* Flag-Stop (GTFS-Flex continuous pickup/drop-off) */}
      <RailDivider />
      <RailSubHeading>Flag-Stop Service</RailSubHeading>
      <div className="mb-4">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Pickup</label>
            <select
              value={route.continuous_pickup ?? ''}
              onChange={(e) => updateRoute(route.route_id, {
                continuous_pickup: e.target.value === '' ? undefined
                  : (Number(e.target.value) as 0 | 1 | 2 | 3),
              })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">Not set (fixed stops only)</option>
              <option value="0">0 — Continuous boarding allowed</option>
              <option value="1">1 — No continuous pickup</option>
              <option value="2">2 — Must phone agency</option>
              <option value="3">3 — Coordinate with driver</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Drop-off</label>
            <select
              value={route.continuous_drop_off ?? ''}
              onChange={(e) => updateRoute(route.route_id, {
                continuous_drop_off: e.target.value === '' ? undefined
                  : (Number(e.target.value) as 0 | 1 | 2 | 3),
              })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">Not set (fixed stops only)</option>
              <option value="0">0 — Continuous alighting allowed</option>
              <option value="1">1 — No continuous drop-off</option>
              <option value="2">2 — Must phone agency</option>
              <option value="3">3 — Coordinate with driver</option>
            </select>
          </div>
        </div>
        <p className="text-[10px] text-warm-gray/80 mt-1">
          Allows passengers to board or alight anywhere along the route, not just at fixed stops. Leave unset unless this is flag-stop / deviated fixed-route service.
        </p>
      </div>


    </div>
  );
}
