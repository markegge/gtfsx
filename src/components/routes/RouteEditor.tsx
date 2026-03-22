import { useMemo } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES } from '../../utils/constants';

export function RouteEditor() {
  const {
    routes, updateRoute, removeRoute, trips, shapes,
    selectedRouteId, selectRoute,
    setMapMode, setDrawingRouteId,
    setEditingRouteId, setEditingShapeId,
    setSidebarSection,
  } = useStore();

  const route = routes.find((r) => r.route_id === selectedRouteId);

  // Find shapes for this route (via trips)
  const routeShapes = useMemo(() => {
    if (!selectedRouteId) return [];
    const routeTrips = trips.filter((t) => t.route_id === selectedRouteId);
    const shapeIds = [...new Set(routeTrips.map((t) => t.shape_id).filter(Boolean))] as string[];
    return shapeIds.map((sid) => {
      const shape = shapes.find((s) => s.shape_id === sid);
      const trip = routeTrips.find((t) => t.shape_id === sid);
      return { shape, trip };
    }).filter((s) => s.shape);
  }, [selectedRouteId, trips, shapes]);

  if (!route) return null;

  const handleBack = () => {
    setEditingRouteId(null);
  };

  const handleDrawShape = () => {
    setDrawingRouteId(route.route_id);
    setMapMode('draw_route');
  };

  const handleEditShape = (shapeId: string) => {
    setEditingShapeId(shapeId);
    setMapMode('edit_shape');
  };

  const handleStopEditShape = () => {
    setEditingShapeId(null);
    setMapMode('select');
  };

  const handleDelete = () => {
    removeRoute(route.route_id);
    selectRoute(null);
    setEditingRouteId(null);
  };

  const editingShapeId = useStore((s) => s.editingShapeId);
  const mapMode = useStore((s) => s.mapMode);

  return (
    <div>
      {/* Header with back button */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={handleBack}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-warm-gray hover:bg-cream hover:text-dark-brown transition-colors text-sm"
        >
          ←
        </button>
        <div
          className="w-4 h-4 rounded shrink-0"
          style={{ backgroundColor: `#${route.route_color}` }}
        />
        <h3 className="font-heading font-bold text-base text-dark-brown truncate">
          {route.route_short_name || route.route_long_name || 'Untitled Route'}
        </h3>
      </div>

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

      {/* Shapes section */}
      <div className="border-t border-sand pt-4 mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          Route Shapes ({routeShapes.length})
        </label>

        {routeShapes.length > 0 ? (
          <div className="flex flex-col gap-1.5 mb-3">
            {routeShapes.map(({ shape, trip }) => (
              <div
                key={shape!.shape_id}
                className="flex items-center gap-2 px-3 py-2 bg-cream rounded-lg text-sm"
              >
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: `#${route.route_color}` }}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-dark-brown font-medium text-xs">
                    {trip?.trip_headsign || (trip?.direction_id === 0 ? 'Outbound' : 'Inbound')}
                  </span>
                  <span className="text-[10px] text-warm-gray ml-1.5">
                    {shape!.points.length} pts
                  </span>
                </div>
                {mapMode === 'edit_shape' && editingShapeId === shape!.shape_id ? (
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        // Discard: restore original and exit
                        setEditingShapeId(null);
                        setMapMode('select');
                      }}
                      className="px-2 py-1 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-red-100 hover:text-red-600 transition-colors"
                      title="Discard changes"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleStopEditShape}
                      className="px-2 py-1 bg-teal text-white rounded text-[11px] font-semibold hover:bg-teal/80 transition-colors"
                      title="Save changes"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handleEditShape(shape!.shape_id)}
                    className="px-2 py-1 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-warm-gray mb-3">
            No shapes drawn yet. Draw a route shape on the map.
          </p>
        )}

        <button
          onClick={handleDrawShape}
          className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
        >
          {routeShapes.length > 0 ? 'Draw Another Shape' : 'Draw Route Shape'}
        </button>

        {mapMode === 'edit_shape' && (
          <div className="mt-2 p-2.5 bg-gold-light rounded-lg">
            <p className="text-xs text-amber-800">
              <strong>Editing shape:</strong> Drag vertices to move them. Click midpoints to add new vertices. Select a vertex and press Delete to remove it. Click "Done" when finished.
            </p>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <button
        onClick={() => {
          selectRoute(route.route_id);
          setSidebarSection('stops');
        }}
        className="w-full px-4 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors mb-2"
      >
        Add Stops to Route
      </button>

      <button
        onClick={() => {
          selectRoute(route.route_id);
          useStore.getState().setBottomPanelOpen(true);
          useStore.getState().setBottomPanelTab('timetable');
          setSidebarSection('timetable');
        }}
        className="w-full px-4 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors mb-4"
      >
        Edit Timetable
      </button>

      <button
        onClick={handleDelete}
        className="text-xs text-red-400 hover:text-red-600"
      >
        Delete route
      </button>
    </div>
  );
}
