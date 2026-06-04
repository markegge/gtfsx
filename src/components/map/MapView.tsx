import { useCallback, useRef, useMemo, useEffect, useState } from 'react';
import Map, { NavigationControl, type MapRef } from 'react-map-gl/mapbox';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';
import type { DrawEvent } from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useStore } from '../../store';
import { DrawControl } from './DrawControl';
import { RouteLayer } from './RouteLayer';
import { StopLayer } from './StopLayer';
import { MapToolbar } from './MapToolbar';
import { DrawingIndicator } from './DrawingIndicator';
import { StopPopup } from './StopPopup';
import { RoutePopup } from './RoutePopup';
import { FlexZonePopup } from './FlexZonePopup';
import { CoverageLayer } from './CoverageLayer';
import { StopAnalysisLayer } from './StopAnalysisLayer';
import { FlexLayer } from '../flex/FlexLayer';
import { DemandDotsLayer } from './DemandDotsLayer';
import { MapLayerControls } from './MapLayerControls';
import { createFlexZoneWithRoute } from '../flex/flexHelpers';
import { shapeEditLabel } from './shapeEditLabel';
import { stopsInsidePolygon, stopsInPolygonTurf } from '../fares/fareZoneHelpers';
import type { MapStyleId } from './MapLayerControls';
import type { MapMouseEvent, MapboxGeoJSONFeature } from 'mapbox-gl';
import type { ShapePoint } from '../../types/gtfs';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { snapToRoadDetailed, type SnapStatus } from '../../services/snapToRoad';
import { simplifyShapePoints } from '../../services/simplifyShape';
import { suggestStopName } from '../../services/suggestStopName';
import { ensureDefaultCalendar } from '../../services/defaultCalendar';
import { trimShapeAtPoint } from '../../services/shapeHelpers';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import distance from '@turf/distance';
import { lineString, point } from '@turf/helpers';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// Round map-derived coordinates to 6 decimals (~0.1 m) so dragging/placing a
// stop doesn't litter the lat/lon fields and stops.txt with float noise.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Create a new blank route (next unused color) and select it. Used when a
 *  drawn shape targets "new route" — created only on finish, never on cancel. */
function createBlankRoute(): string {
  const st = useStore.getState();
  const usedColors = st.routes.map((r) => r.route_color);
  const nextColor = ROUTE_COLORS.find((c) => !usedColors.includes(c)) || ROUTE_COLORS[0];
  const id = generateId('route');
  st.addRoute({
    route_id: id,
    agency_id: st.agencies[0]?.agency_id || '',
    route_short_name: '',
    route_long_name: '',
    route_type: 3,
    route_color: nextColor,
    route_text_color: getContrastTextColor(nextColor),
  });
  st.selectRoute(id);
  return id;
}

/** Create a shape from drawn coords + a stub trip pointing at it, for the given
 *  route and direction. Shared by the draw-finish handler and the snap-warning
 *  "keep unsnapped" path. */
function createShapeAndTrip(coords: [number, number][], routeId: string, direction: 0 | 1) {
  const shapeId = generateId('shape');
  let points = coords.map((c, i) => ({
    shape_pt_lat: c[1],
    shape_pt_lon: c[0],
    shape_pt_sequence: i,
    shape_dist_traveled: 0,
  }));
  // Auto-simplify if the drawn line has too many points (freehand creates ~1 per pixel)
  if (points.length > 20) {
    points = simplifyShapePoints(points, 0.00005); // Light simplify ~5m
  }

  const st = useStore.getState();
  st.addShape({ shape_id: shapeId, points });
  st.recalcShapeDistances(shapeId);

  const route = st.routes.find((r) => r.route_id === routeId);
  const routeName = route?.route_short_name || route?.route_long_name || '';
  // Materialize a Default Calendar on the fly if the project has no calendars
  // yet — otherwise the trip would point at the hardcoded "service-1"
  // placeholder and the timetable would show two unrelated services later.
  const serviceId = ensureDefaultCalendar();
  const svcIdx = st.calendars.findIndex((c) => c.service_id === serviceId) + 1 || 1;
  const prefix = (routeName || 'trip').replace(/\s+/g, '').slice(0, 4).toLowerCase();
  const existingIds = new Set(st.trips.map((t) => t.trip_id));
  let tripId = `${svcIdx}${prefix}_new`;
  if (existingIds.has(tripId)) { let s = 2; while (existingIds.has(`${tripId}${s}`)) s++; tripId = `${tripId}${s}`; }
  st.addTrip({
    trip_id: tripId,
    route_id: routeId,
    service_id: serviceId,
    direction_id: direction,
    shape_id: shapeId,
    trip_headsign: '',
  });
}

/** Leave draw mode and open the Route Shapes editor for the route just drawn. */
function finishDrawingTo(routeId: string) {
  const st = useStore.getState();
  st.setMapMode('select');
  st.setDrawingRouteId(null);
  st.setSidebarSection('routes');
  st.selectRoute(routeId);
  st.setEditingRouteId(routeId);
}

export function MapView() {
  const mapRef = useRef<MapRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  // Only destructure values used for rendering; handlers read from useStore.getState() directly
  const mapMode = useStore((s) => s.mapMode);
  const editingShapeId = useStore((s) => s.editingShapeId);
  const editingFlexZoneId = useStore((s) => s.editingFlexZoneId);
  const editingStopId = useStore((s) => s.editingStopId);
  const stops = useStore((s) => s.stops);
  const shapes = useStore((s) => s.shapes);
  const trips = useStore((s) => s.trips);
  const routes = useStore((s) => s.routes);

  // "{route} · {shape}" label for the edit banner (null → generic fallback).
  const editingLabel = useMemo(
    () => shapeEditLabel(editingShapeId, shapes, trips, routes),
    [editingShapeId, shapes, trips, routes],
  );

  // Popup state
  const [popupStopId, setPopupStopId] = useState<string | null>(null);
  const [popupRouteId, setPopupRouteId] = useState<string | null>(null);
  // shape_id of the clicked route polyline — drives the popup's Edit Shape
  // button. Captured at click time so a per-shape variant on the same route
  // is reachable without having to disambiguate after the fact.
  const [popupShapeId, setPopupShapeId] = useState<string | null>(null);
  // Whether mapbox-gl-draw currently has at least one vertex (mid-point or
  // existing) selected. Gates the on-map "Delete Selected Vertex" button so
  // it doesn't sit there unreachable when nothing is selected.
  const [editVertexSelected, setEditVertexSelected] = useState(false);
  const [popupLngLat, setPopupLngLat] = useState<{ lng: number; lat: number } | null>(null);
  const [popupDirectionId, setPopupDirectionId] = useState<0 | 1>(0);
  const [popupFlexZoneId, setPopupFlexZoneId] = useState<string | null>(null);

  // Track the last stop placed (for ESC undo)
  const lastPlacedStopRef = useRef<string | null>(null);
  // Track the draw feature ID for shape/zone editing
  const editDrawFeatureIdRef = useRef<string | null>(null);
  // Snapshot of original shape points before editing (for discard)
  const originalShapePointsRef = useRef<ShapePoint[] | null>(null);
  // Snapshot of original flex zone geojson before editing (for discard)
  const originalFlexZoneGeojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  // Confirm discard dialog
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // (Shape-split state removed — superseded by Duplicate + Trim in the Routes
  // Shapes subpanel, which compose the same outcome without a special mode.)
  // Snapping indicator
  const [isSnapping, setIsSnapping] = useState(false);
  // Set when a just-drawn route shape couldn't be fully snapped to roads, so the
  // user can keep their unsnapped drawing or discard it and redraw.
  const [snapWarning, setSnapWarning] = useState<{
    rawCoords: [number, number][];
    routeId: string | null; // null when the draw targets a new route
    isNewRoute: boolean;
    direction: 0 | 1;
    status: Exclude<SnapStatus, 'ok'>;
  } | null>(null);
  // Map layer controls
  const [mapStyleId, setMapStyleId] = useState<MapStyleId>('light');
  const [showDemandDots, setShowDemandDots] = useState(false);
  // Cursor: pointer when hovering over a clickable feature in select mode
  const [hoveringFeature, setHoveringFeature] = useState(false);
  const [hoveringStop, setHoveringStop] = useState(false);
  // Very-large-feed map perf: once too many stops / shape points fall in the
  // current viewport, cluster stops and render simplified shapes so Mapbox
  // isn't asked to draw everything at once. Recomputed on map move.
  const [clusterStops, setClusterStops] = useState(false);
  const [simplifyShapes, setSimplifyShapes] = useState(false);
  // Stop move state (for didDragStop compat with click handler)
  const didDragStopRef = useRef(false);

  // Compute initial view from stops or shapes. Recompute only when the
  // "any data?" boolean flips — avoids re-running on every stop edit.
  const hasAnyData = stops.length > 0 || shapes.length > 0;
  const initialView = useMemo(() => {
    // Track min/max in a single pass. NB: do NOT collect into arrays and spread
    // into Math.min(...arr) — a regional feed has hundreds of thousands of
    // shape points, and spreading that many args overflows the call stack
    // (RangeError) and crashes the map.
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let any = false;
    const consider = (lat: number, lon: number) => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      any = true;
    };
    for (const s of stops) consider(s.stop_lat, s.stop_lon);
    for (const s of shapes) for (const p of s.points) consider(p.shape_pt_lat, p.shape_pt_lon);

    if (any) {
      return {
        latitude: (minLat + maxLat) / 2,
        longitude: (minLon + maxLon) / 2,
        zoom: 12,
      };
    }
    return { latitude: 45.68, longitude: -111.05, zoom: 12 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAnyData]);

  // ESC key handler — use capture phase so we fire before mapbox-gl-draw
  useEffect(() => {
    // Prevent mapbox-gl-draw's own Escape handling (keyup) from canceling the draw
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useStore.getState().mapMode === 'draw_route') {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const currentMode = useStore.getState().mapMode;
        if (currentMode === 'place_stop') {
          if (lastPlacedStopRef.current) {
            const sid = lastPlacedStopRef.current;
            const sr = useStore.getState().selectedRouteId;
            if (sr) {
              useStore.getState().removeRouteStop(sr, sid, 0);
              useStore.getState().removeRouteStop(sr, sid, 1);
            }
            useStore.getState().removeStop(sid);
            lastPlacedStopRef.current = null;
          }
          useStore.getState().setMapMode('select');
          return;
        }
        if (currentMode === 'move_stop') {
          useStore.getState().setMapMode('select');
          return;
        }
        if (currentMode === 'draw_route') {
          e.preventDefault();
          e.stopPropagation();
          if (drawRef.current) {
            const draw = drawRef.current;
            const feature = draw.getAll().features[0];
            if (feature && feature.geometry.type === 'LineString') {
              // While drawing, the line's last coordinate is the live cursor; the
              // user-placed vertices are everything before it.
              const placed = (feature.geometry.coordinates as [number, number][]).slice(0, -1);
              const kept = placed.slice(0, -1); // drop the most recently placed vertex
              if (kept.length >= 1) {
                // Re-enter draw_line_string from the kept vertices rather than
                // splice()+set(): mapbox-gl-draw keeps an internal
                // currentVertexPosition that set() doesn't update, so the next
                // mousemove would re-append a vertex at the cursor — the bug this
                // fixes. The continue API needs a >=2-coord line, so a single
                // remaining vertex is padded; handleDrawCreate strips the dup.
                const lineCoords = kept.length >= 2 ? kept : [kept[0], kept[0]];
                draw.deleteAll();
                const feat: GeoJSON.Feature<GeoJSON.LineString> = {
                  type: 'Feature',
                  properties: {},
                  geometry: { type: 'LineString', coordinates: lineCoords },
                };
                const ids = draw.add(feat);
                draw.changeMode('draw_line_string', {
                  featureId: ids[0],
                  from: lineCoords[lineCoords.length - 1],
                });
                return; // stay in draw mode, one vertex shorter
              }
            }
            // Nothing left to keep — cancel drawing entirely.
            draw.deleteAll();
          }
          useStore.getState().setMapMode('select');
          useStore.getState().setDrawingRouteId(null);
          return;
        }
        if (currentMode === 'edit_shape') {
          setShowDiscardConfirm(true);
          return;
        }
        if (currentMode === 'draw_flex_zone') {
          if (drawRef.current) drawRef.current.deleteAll();
          useStore.getState().setMapMode('select');
          return;
        }
        if (currentMode === 'select_stops_polygon') {
          // Cancel the Fares v2 Areas lasso: drop the in-progress polygon and
          // return to select without touching stop_areas.
          if (drawRef.current) drawRef.current.deleteAll();
          delete window.__lassoStopAreaId;
          useStore.getState().setMapMode('select');
          return;
        }
        if (currentMode === 'edit_flex_zone') {
          // Revert to original zone geometry
          const zoneId = useStore.getState().editingFlexZoneId;
          if (zoneId && originalFlexZoneGeojsonRef.current) {
            useStore.getState().updateFlexZone(zoneId, { geojson: originalFlexZoneGeojsonRef.current });
          }
          if (drawRef.current) drawRef.current.deleteAll();
          originalFlexZoneGeojsonRef.current = null;
          editDrawFeatureIdRef.current = null;
          useStore.getState().setEditingFlexZoneId(null);
          useStore.getState().setMapMode('select');
          return;
        }
        setPopupStopId(null);
        setPopupRouteId(null);
      }

      // Delete/Backspace in edit_shape mode — explicitly call trash()
      if ((e.key === 'Delete' || e.key === 'Backspace') && useStore.getState().mapMode === 'edit_shape') {
        // Only handle if not in an input/textarea
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        if (drawRef.current) {
          drawRef.current.trash();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, []);

  // Resize the map whenever its container changes size — not just on window
  // resize. The rails (left/right) and bottom panel resize the container
  // without a window resize event, so Mapbox's default trackResize misses
  // them and the canvas is left smaller than its box (the gap next to the
  // right rail). A ResizeObserver covers every layout change.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      mapRef.current?.getMap?.()?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // === Shape editing: Save and Discard ===

  const saveShapeEdit = useCallback(() => {
    const currentEditingId = useStore.getState().editingShapeId;
    if (drawRef.current && currentEditingId) {
      const all = drawRef.current.getAll();
      if (all.features.length > 0) {
        const feature = all.features[0];
        if (feature.geometry.type === 'LineString') {
          const coords = feature.geometry.coordinates;
          const points = coords.map((c: number[], i: number) => ({
            shape_pt_lat: c[1],
            shape_pt_lon: c[0],
            shape_pt_sequence: i,
            shape_dist_traveled: 0,
          }));
          useStore.getState().updateShapePoints(currentEditingId, points);
          useStore.getState().recalcShapeDistances(currentEditingId);
        }
      }
      drawRef.current.deleteAll();
    }
    editDrawFeatureIdRef.current = null;
    originalShapePointsRef.current = null;
    useStore.getState().setEditingShapeId(null);
    useStore.getState().setMapMode('select');
  }, []);

  const discardShapeEdit = useCallback(() => {
    const currentEditingId = useStore.getState().editingShapeId;
    if (currentEditingId && originalShapePointsRef.current) {
      useStore.getState().updateShapePoints(currentEditingId, originalShapePointsRef.current);
      useStore.getState().recalcShapeDistances(currentEditingId);
    }
    if (drawRef.current) drawRef.current.deleteAll();
    editDrawFeatureIdRef.current = null;
    originalShapePointsRef.current = null;
    useStore.getState().setEditingShapeId(null);
    useStore.getState().setMapMode('select');
    setShowDiscardConfirm(false);
  }, []);

  // Save / discard for flex zone editing
  const saveFlexZoneEdit = useCallback(() => {
    if (drawRef.current) drawRef.current.deleteAll();
    originalFlexZoneGeojsonRef.current = null;
    editDrawFeatureIdRef.current = null;
    useStore.getState().setEditingFlexZoneId(null);
    useStore.getState().setMapMode('select');
  }, []);

  const discardFlexZoneEdit = useCallback(() => {
    const zoneId = useStore.getState().editingFlexZoneId;
    if (zoneId && originalFlexZoneGeojsonRef.current) {
      useStore.getState().updateFlexZone(zoneId, { geojson: originalFlexZoneGeojsonRef.current });
    }
    if (drawRef.current) drawRef.current.deleteAll();
    originalFlexZoneGeojsonRef.current = null;
    editDrawFeatureIdRef.current = null;
    useStore.getState().setEditingFlexZoneId(null);
    useStore.getState().setMapMode('select');
  }, []);

  // One-shot "fit map to project data" on initial load. The Map component's
  // initialViewState is computed at mount, often BEFORE async project data
  // (loadProjectFromServer / loadDemoFeed / loadImportIntoStore) has populated
  // the store — so the map opens centered on Bozeman regardless of where the
  // feed actually is. This effect waits for both the mapbox instance to be
  // ready and the store to contain stops/shapes, then fits once.
  const initialFitDoneRef = useRef(false);
  useEffect(() => {
    if (initialFitDoneRef.current) return;
    if (stops.length === 0 && shapes.length === 0) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return; // Map not initialized yet; re-runs on the next data tick.
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const s of stops) {
      if (s.stop_lat < minLat) minLat = s.stop_lat;
      if (s.stop_lat > maxLat) maxLat = s.stop_lat;
      if (s.stop_lon < minLon) minLon = s.stop_lon;
      if (s.stop_lon > maxLon) maxLon = s.stop_lon;
    }
    for (const sh of shapes) {
      for (const p of sh.points) {
        if (p.shape_pt_lat < minLat) minLat = p.shape_pt_lat;
        if (p.shape_pt_lat > maxLat) maxLat = p.shape_pt_lat;
        if (p.shape_pt_lon < minLon) minLon = p.shape_pt_lon;
        if (p.shape_pt_lon > maxLon) maxLon = p.shape_pt_lon;
      }
    }
    if (!Number.isFinite(minLat) || minLat === maxLat || minLon === maxLon) return;
    map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 60,
      maxZoom: 14,
      duration: 0,
    });
    initialFitDoneRef.current = true;
  }, [stops, shapes]);

  // When a stop goes into edit mode, zoom in to a tight view centered on it —
  // past the cluster max-zoom, so on a large (clustered) feed the stop renders
  // as an individual, selectable point rather than being swallowed by a
  // cluster. Never zooms out if the user is already closer.
  useEffect(() => {
    if (!editingStopId) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const stop = useStore.getState().stops.find((s) => s.stop_id === editingStopId);
    if (!stop) return;
    map.flyTo({
      center: [stop.stop_lon, stop.stop_lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: 600,
    });
  }, [editingStopId]);

  // Cluster stops for large feeds. Gated on TOTAL stop count (stable per feed)
  // rather than per-viewport — toggling a Mapbox source's clustering on the fly
  // is fragile, whereas a stable flag means the clustered source mounts once.
  // Mapbox's clusterMaxZoom then restores individual stops as you zoom in, so
  // you still get detail where few stops are visible and clusters where many are.
  const LARGE_STOP_COUNT = 2000;
  useEffect(() => {
    setClusterStops(stops.length > LARGE_STOP_COUNT);
  }, [stops.length]);

  // Simplify shape geometry once too many shape points fall in the viewport.
  // This only swaps the source's `data` (cheap, no source recreation), so it's
  // safe to flip on every move. Counting short-circuits at the threshold and
  // runs on moveend/idle, so it stays cheap even for RTD-scale feeds.
  const SHAPE_SIMPLIFY_LIMIT = 20000; // > this many shape points visible → simplify
  useEffect(() => {
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const recompute = () => {
      const b = map.getBounds();
      if (!b) return;
      const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth();
      let ptCount = 0;
      let simplifyNow = false;
      outer: for (const sh of useStore.getState().shapes) {
        for (const p of sh.points) {
          if (p.shape_pt_lon >= west && p.shape_pt_lon <= east &&
              p.shape_pt_lat >= south && p.shape_pt_lat <= north &&
              ++ptCount > SHAPE_SIMPLIFY_LIMIT) { simplifyNow = true; break outer; }
        }
      }
      setSimplifyShapes(simplifyNow);
    };
    // 'idle' covers the data-driven initial fit (incl. duration:0) that
    // 'moveend' can miss; the setter bails when unchanged, so no loop.
    map.on('moveend', recompute);
    map.on('idle', recompute);
    recompute();
    return () => { map.off('moveend', recompute); map.off('idle', recompute); };
  }, [shapes]);

  // Expose map flyTo on window for sidebar components
  useEffect(() => {
    window.__mapFlyTo = (lng: number, lat: number, zoom?: number) => {
      mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? mapRef.current.getZoom(), duration: 500 });
    };
    window.__mapFitBounds = (
      bounds: [[number, number], [number, number]],
      opts?: { padding?: number; maxZoom?: number; duration?: number },
    ) => {
      mapRef.current?.fitBounds(bounds, {
        padding: opts?.padding ?? 60,
        maxZoom: opts?.maxZoom ?? 14,
        duration: opts?.duration ?? 800,
      });
    };
    return () => {
      delete window.__mapFlyTo;
      delete window.__mapFitBounds;
    };
  }, []);

  // Expose save/discard on window so RouteEditor / FlexEditor can call them
  useEffect(() => {
    window.__shapeEditSave = saveShapeEdit;
    window.__shapeEditDiscard = discardShapeEdit;
    window.__flexZoneEditSave = saveFlexZoneEdit;
    window.__flexZoneEditDiscard = discardFlexZoneEdit;
    // Cancel an in-progress Draw Route — used by the toolbar to toggle the
    // Draw Route button off without requiring the user to finish the line.
    // Mirrors the cleanup the ESC handler does when no vertices remain.
    window.__cancelDrawRoute = () => {
      if (drawRef.current) drawRef.current.deleteAll();
      useStore.getState().setDrawingRouteId(null);
      useStore.getState().setDrawingNewRoute(false);
      useStore.getState().setMapMode('select');
    };
    return () => {
      delete window.__shapeEditSave;
      delete window.__shapeEditDiscard;
      delete window.__flexZoneEditSave;
      delete window.__flexZoneEditDiscard;
      delete window.__cancelDrawRoute;
    };
  }, [saveShapeEdit, discardShapeEdit, saveFlexZoneEdit, discardFlexZoneEdit]);

  // Load shape / flex zone into draw when entering the relevant editing mode
  useEffect(() => {
    if (!drawRef.current) return;
    const currentMode = useStore.getState().mapMode;
    const currentEditingId = useStore.getState().editingShapeId;
    const currentFlexZoneId = useStore.getState().editingFlexZoneId;

    if (currentMode === 'edit_shape' && currentEditingId) {
      const shape = useStore.getState().shapes.find((s) => s.shape_id === currentEditingId);
      if (!shape) return;

      // Snapshot original points for discard
      originalShapePointsRef.current = JSON.parse(JSON.stringify(shape.points));

      // Clear any existing draw features
      drawRef.current.deleteAll();

      // Add the shape as a LineString feature
      const feature: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: { shape_id: currentEditingId },
        geometry: {
          type: 'LineString',
          coordinates: shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
        },
      };
      const ids = drawRef.current.add(feature);
      const featureId = Array.isArray(ids) ? ids[0] : ids;
      editDrawFeatureIdRef.current = featureId;

      // Switch to direct_select mode so vertices are immediately editable
      drawRef.current.changeMode('direct_select', { featureId });
    } else if (currentMode === 'edit_flex_zone' && currentFlexZoneId) {
      const zone = useStore.getState().flexZones.find((z) => z.id === currentFlexZoneId);
      if (!zone || zone.geojson.features.length === 0) return;

      // Snapshot original geometry for discard
      originalFlexZoneGeojsonRef.current = JSON.parse(JSON.stringify(zone.geojson));

      drawRef.current.deleteAll();

      // Load the first polygon feature into draw
      const feat = zone.geojson.features[0];
      const ids = drawRef.current.add(feat);
      const featureId = Array.isArray(ids) ? ids[0] : ids;
      editDrawFeatureIdRef.current = featureId;

      drawRef.current.changeMode('direct_select', { featureId });
    } else if (
      currentMode === 'draw_flex_zone' ||
      currentMode === 'draw_fare_zone' ||
      currentMode === 'select_stops_polygon'
    ) {
      // All draw a fresh polygon. draw_fare_zone and select_stops_polygon are
      // one-shot lassos: the draw-complete handler stamps the enclosed stops
      // (a zone_id, or a Fares v2 stop_areas membership) and returns to select
      // mode without persisting any polygon geometry.
      drawRef.current.deleteAll();
      drawRef.current.changeMode('draw_polygon');
    } else if (currentMode === 'draw_route') {
      drawRef.current.changeMode('draw_line_string');
    } else if (currentMode === 'select') {
      // Clean up any leftover draw features when leaving an editing mode
      // without an explicit Save/Cancel (e.g. the shape was deleted while
      // edited).
      try { drawRef.current.deleteAll(); } catch { /* ignore */ }
      try { drawRef.current.changeMode('simple_select'); } catch { /* ignore */ }
      editDrawFeatureIdRef.current = null;
      originalShapePointsRef.current = null;
      setEditVertexSelected(false);
    }
  }, [mapMode, editingShapeId, editingFlexZoneId]);

  // Track vertex-selection state from mapbox-gl-draw so the on-map
  // "Delete Selected Vertex" button can hide when nothing is selected.
  // Only relevant while we're in edit_shape — listener detaches otherwise.
  useEffect(() => {
    if (mapMode !== 'edit_shape') {
      setEditVertexSelected(false);
      return;
    }
    const map = mapRef.current?.getMap();
    if (!map) return;
    const onChange = (e: { points?: unknown[] }) => {
      setEditVertexSelected(Array.isArray(e.points) && e.points.length > 0);
    };
    // mapbox-gl-draw's draw.* events aren't in the mapbox-gl event-name type,
    // but the runtime accepts arbitrary strings — cast through unknown to
    // satisfy the type checker without an @ts-expect-error.
    const m = map as unknown as {
      on: (ev: string, h: (e: { points?: unknown[] }) => void) => void;
      off: (ev: string, h: (e: { points?: unknown[] }) => void) => void;
    };
    m.on('draw.selectionchange', onChange);
    return () => { m.off('draw.selectionchange', onChange); };
  }, [mapMode]);

  // Drag-to-move stop in move_stop mode
  const draggingStopRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const onMouseDown = (e: MapMouseEvent) => {
      if (useStore.getState().mapMode !== 'move_stop') return;
      const stopId = useStore.getState().selectedStopId;
      if (!stopId) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['stop-circles', 'stop-circles-outer'] });
      const hit = features.some((f: MapboxGeoJSONFeature) => f.properties?.stop_id === stopId);
      if (!hit) return;

      e.preventDefault();
      draggingStopRef.current = true;
      map.getCanvas().style.cursor = 'grabbing';
      map.dragPan.disable();
    };

    const onMouseMove = (e: MapMouseEvent) => {
      if (!draggingStopRef.current) return;
      const stopId = useStore.getState().selectedStopId;
      if (!stopId) return;
      didDragStopRef.current = true;
      useStore.getState().updateStop(stopId, {
        stop_lat: round6(e.lngLat.lat),
        stop_lon: round6(e.lngLat.lng),
      });
    };

    const onMouseUp = () => {
      if (!draggingStopRef.current) return;
      draggingStopRef.current = false;
      // Clear the inline cursor override so React's <Map cursor={…}> prop
      // takes over — the mouse is still hovering the stop at this point,
      // so it'll resolve to 'grab'.
      map.getCanvas().style.cursor = '';
      map.dragPan.enable();
      setHoveringStop(true);
      setTimeout(() => { didDragStopRef.current = false; }, 0);
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
    };
  }, [mapMode]);

  const handleDrawCreate = useCallback((e: DrawEvent) => {
    const feature = e.features[0];
    if (!feature) return;

    const currentState = useStore.getState();

    // Flex zone drawn. Two cases:
    //  (a) __flexAddPolygonZoneId is set → append this polygon to an existing
    //      zone (used to add polygon geometry to a group zone, making it
    //      "mixed"); leaves the zone's stop group intact.
    //  (b) otherwise → save as a brand-new polygon zone + paired route.
    if (currentState.mapMode === 'draw_flex_zone' && feature.geometry.type === 'Polygon') {
      const addToZoneId = window.__flexAddPolygonZoneId;
      if (addToZoneId) {
        const zone = currentState.flexZones.find((z) => z.id === addToZoneId);
        if (zone) {
          currentState.updateFlexZone(addToZoneId, {
            geojson: {
              type: 'FeatureCollection',
              features: [...(zone.geojson.features || []), feature],
            },
          });
        }
        delete window.__flexAddPolygonZoneId;
      } else {
        const geojson: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [feature] };
        const zoneNum = currentState.flexZones.length + 1;
        createFlexZoneWithRoute({
          id: `flex-zone-${Date.now()}`,
          name: `Zone ${zoneNum}`,
          bufferMiles: 0,
          geojson,
        });
      }
      useStore.getState().setMapMode('select');
      if (drawRef.current) drawRef.current.deleteAll();
      return;
    }

    // Fare-zone lasso drawn — stamp the chosen zone_id onto every stop inside
    // the polygon, then discard the polygon (one-shot bulk assign; GTFS fare
    // zones have no geometry, so nothing about the shape is persisted).
    if (currentState.mapMode === 'draw_fare_zone' && feature.geometry.type === 'Polygon') {
      const zoneId = (window.__lassoFareZoneId ?? '').trim();
      if (zoneId) {
        const insideIds = new Set(
          stopsInsidePolygon(currentState.stops, feature as GeoJSON.Feature<GeoJSON.Polygon>),
        );
        if (insideIds.size > 0) {
          currentState.setStops(
            currentState.stops.map((s) =>
              insideIds.has(s.stop_id) ? { ...s, zone_id: zoneId } : s,
            ),
          );
        }
        window.__onFareZoneAssigned?.(insideIds.size, zoneId);
      }
      useStore.getState().setMapMode('select');
      if (drawRef.current) drawRef.current.deleteAll();
      return;
    }

    // Fares v2 Areas "select stops by polygon" lasso — bulk-add every stop
    // inside the drawn polygon to the target area's stop_areas, then discard
    // the polygon. The polygon is a transient selection tool only: GTFS-Fares
    // v2 areas have NO geometry (membership lives in stop_areas.txt), so nothing
    // about the drawn shape is persisted and no flex zone is created.
    if (currentState.mapMode === 'select_stops_polygon' && feature.geometry.type === 'Polygon') {
      const areaId = (window.__lassoStopAreaId ?? '').trim();
      if (areaId) {
        const insideIds = stopsInPolygonTurf(
          currentState.stops,
          feature as GeoJSON.Feature<GeoJSON.Polygon>,
        );
        // Count only the stops not already assigned to this area (what we
        // actually add) so the panel's confirmation reflects the real delta.
        const already = new Set(
          currentState.stopAreas
            .filter((sa) => sa.area_id === areaId)
            .map((sa) => sa.stop_id),
        );
        const addedCount = insideIds.reduce((n, id) => (already.has(id) ? n : n + 1), 0);
        if (insideIds.length > 0) {
          currentState.addStopsToArea(areaId, insideIds);
        }
        window.__onStopAreaPolygonSelect?.(addedCount, areaId);
      }
      useStore.getState().setMapMode('select');
      if (drawRef.current) drawRef.current.deleteAll();
      return;
    }

    const currentDrawingRouteId = currentState.drawingRouteId;
    const currentDrawingNewRoute = currentState.drawingNewRoute;
    const currentSnapToRoad = currentState.snapToRoad;

    if (feature.geometry.type === 'LineString' && (currentDrawingRouteId || currentDrawingNewRoute)) {
      // Drop consecutive duplicate coordinates — a clean drawing never has them,
      // but the Escape-to-undo re-entry pads a single remaining vertex (and a
      // stray double-click can too); strip them so shapes have no zero-length legs.
      const rawCoords = (feature.geometry.coordinates as [number, number][]).filter(
        (c, i, arr) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1],
      );

      // Read the drawing direction from window (set by RouteEditor)
      const drawingDirection: 0 | 1 = window.__drawingDirection ?? 0;

      if (drawRef.current) drawRef.current.deleteAll();

      // Commit a shape: create the target route now if the draw targets "new",
      // otherwise attach to the chosen existing route. Done only on commit, so
      // cancelling or discarding never leaves an empty route behind.
      const commitShape = (coords: [number, number][]) => {
        const routeId = currentDrawingNewRoute || !currentDrawingRouteId
          ? createBlankRoute()
          : currentDrawingRouteId;
        createShapeAndTrip(coords, routeId, drawingDirection);
        useStore.getState().setDrawingNewRoute(false);
        finishDrawingTo(routeId);
      };

      if (currentSnapToRoad) {
        setIsSnapping(true);
        snapToRoadDetailed(rawCoords)
          .then((result) => {
            if (result.status === 'ok') {
              commitShape(result.snapped);
            } else {
              // Couldn't fully snap (roadless diversion / no match). Ask whether
              // to keep the unsnapped drawing or discard it, rather than silently
              // saving a cut-off shape. Defer route creation until "keep".
              setSnapWarning({
                rawCoords,
                routeId: currentDrawingRouteId,
                isNewRoute: currentDrawingNewRoute,
                direction: drawingDirection,
                status: result.status,
              });
            }
          })
          .catch(() => {
            setSnapWarning({
              rawCoords,
              routeId: currentDrawingRouteId,
              isNewRoute: currentDrawingNewRoute,
              direction: drawingDirection,
              status: 'failed',
            });
          })
          .finally(() => setIsSnapping(false));
      } else {
        commitShape(rawCoords);
      }
    }
  }, []);

  // Snap-warning resolutions: keep the raw drawn shape (creating the new route
  // now if that's the target), or discard it and re-arm the draw tool.
  const handleKeepUnsnapped = () => {
    if (!snapWarning) return;
    const routeId = snapWarning.isNewRoute || !snapWarning.routeId
      ? createBlankRoute()
      : snapWarning.routeId;
    createShapeAndTrip(snapWarning.rawCoords, routeId, snapWarning.direction);
    useStore.getState().setDrawingNewRoute(false);
    finishDrawingTo(routeId);
    setSnapWarning(null);
  };

  const handleDiscardAndRedraw = () => {
    if (!snapWarning) return;
    const { routeId, isNewRoute, direction } = snapWarning;
    setSnapWarning(null);
    window.__drawingDirection = direction;
    const st = useStore.getState();
    st.setDrawingNewRoute(isNewRoute);
    st.setDrawingRouteId(isNewRoute ? null : routeId);
    st.setMapMode('draw_route');
    if (drawRef.current) {
      try { drawRef.current.deleteAll(); } catch { /* ignore */ }
      try { drawRef.current.changeMode('draw_line_string'); } catch { /* ignore */ }
    }
  };

  const handleDrawUpdate = useCallback((e: DrawEvent) => {
    // Read current state directly to avoid stale closures
    const currentState = useStore.getState();

    // Flex zone vertex edit
    if (currentState.mapMode === 'edit_flex_zone' && currentState.editingFlexZoneId) {
      const feature = e.features[0];
      if (!feature || feature.geometry.type !== 'Polygon') return;
      const geojson: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [feature] };
      currentState.updateFlexZone(currentState.editingFlexZoneId, { geojson });
      return;
    }

    if (currentState.mapMode === 'edit_shape' && currentState.editingShapeId) {
      const feature = e.features[0];
      if (!feature || feature.geometry.type !== 'LineString') return;
      const coords = feature.geometry.coordinates;
      const points = coords.map((c: number[], i: number) => ({
        shape_pt_lat: c[1],
        shape_pt_lon: c[0],
        shape_pt_sequence: i,
        shape_dist_traveled: 0,
      }));
      currentState.updateShapePoints(currentState.editingShapeId, points);
      currentState.recalcShapeDistances(currentState.editingShapeId);
    }
  }, []);

  const handleMapClick = useCallback((e: MapMouseEvent & { features?: MapboxGeoJSONFeature[] }) => {
    // Ignore clicks that are the end of a stop drag
    if (didDragStopRef.current) return;

    const currentState = useStore.getState();

    // Don't handle map clicks during shape editing
    if (currentState.mapMode === 'edit_shape') return;

    // Move stop mode — click to relocate the selected stop (skip if just finished dragging)
    if (currentState.mapMode === 'move_stop' && currentState.selectedStopId) {
      if (!didDragStopRef.current) {
        currentState.updateStop(currentState.selectedStopId, {
          stop_lat: round6(e.lngLat.lat),
          stop_lon: round6(e.lngLat.lng),
        });
      }
      return;
    }

    // Trim mode — user picked one end of the shape to cut. The shape id
    // and side were stashed on window globals by RouteShapesTab.beginTrim
    // (small enough payload that a transient store field isn't worth it).
    if (currentState.mapMode === 'trim_shape') {
      const shapeId = window.__trimShapeId;
      const side = window.__trimShapeSide;
      if (!shapeId || !side) {
        currentState.setMapMode('select');
        return;
      }
      const shape = currentState.shapes.find((s) => s.shape_id === shapeId);
      if (!shape || shape.points.length < 2) {
        currentState.setMapMode('select');
        return;
      }
      const newPoints = trimShapeAtPoint(shape, side, e.lngLat.lng, e.lngLat.lat);
      // If the helper refused (would have left fewer than 2 points), bail
      // without mutating; the user can pick a different click point.
      if (newPoints !== shape.points) {
        currentState.updateShapePoints(shapeId, newPoints);
        currentState.recalcShapeDistances(shapeId);
      }
      window.__trimShapeId = undefined;
      window.__trimShapeSide = undefined;
      currentState.setMapMode('select');
      return;
    }

    // Stop placement mode — drops a new stop at the click location. Supports
    // two contexts: with a route selected (snap-to-route + auto-add to route),
    // or standalone (just create the stop, no route assignment).
    if (currentState.mapMode === 'place_stop') {
      const clickLat = e.lngLat.lat;
      const clickLon = e.lngLat.lng;
      let stopLat = clickLat;
      let stopLon = clickLon;
      let bestDirectionId: 0 | 1 = currentState.stopPlacementDirection;
      // The shape the new stop attaches to. Defaults to the shape being edited
      // (set by the Stops panel); snap-to-route may refine it to the nearest.
      let bestShapeId: string | undefined = currentState.stopPlacementShapeId ?? undefined;
      const hasRoute = !!currentState.selectedRouteId;

      if (hasRoute && currentState.stopPlacementMode === 'snap_to_route') {
        const routeTrips = currentState.trips.filter((t) => t.route_id === currentState.selectedRouteId);
        let shapeTrips = routeTrips.filter((t) => t.shape_id);
        // When a specific shape is being edited, snap only to it — out-and-back
        // shapes overlap, so "nearest shape" would be ambiguous.
        if (currentState.stopPlacementShapeId) {
          shapeTrips = shapeTrips.filter((t) => t.shape_id === currentState.stopPlacementShapeId);
        }
        let bestDist = Infinity;

        for (const trip of shapeTrips) {
          const shape = currentState.shapes.find((s) => s.shape_id === trip.shape_id);
          if (!shape || shape.points.length < 2) continue;

          const coords = shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
          const line = lineString(coords);
          const clickPoint = point([clickLon, clickLat]);
          const snapped = nearestPointOnLine(line, clickPoint);
          const dist = distance(clickPoint, snapped, { units: 'meters' });

          if (dist < bestDist) {
            bestDist = dist;
            stopLat = snapped.geometry.coordinates[1];
            stopLon = snapped.geometry.coordinates[0];
            bestDirectionId = trip.direction_id;
            bestShapeId = trip.shape_id;
          }
        }
      }

      const stopId = generateId('stop');
      // Precedence for the stop_name: user-typed override in the place-stop
      // dialog wins; otherwise default placeholder + async intersection
      // suggestion. The override is single-use — clear it so the next stop
      // gets a fresh suggestion (or its own typed name).
      const override = currentState.nextStopName?.trim();
      const defaultName = `Stop ${currentState.stops.length + 1}`;
      const initialName = override || defaultName;
      currentState.addStop({
        stop_id: stopId,
        stop_name: initialName,
        stop_lat: round6(stopLat),
        stop_lon: round6(stopLon),
        location_type: 0,
        wheelchair_boarding: 0,
      });
      if (override) currentState.setNextStopName(null);

      // Fire-and-forget: try to auto-name the stop after the nearest
      // intersection ("1st Ave and Main St"). Only overwrites the default
      // placeholder — skipped entirely if the user supplied a name override.
      if (!override) {
        void suggestStopName(stopLon, stopLat).then((name) => {
          if (!name) return;
          const cur = useStore.getState().stops.find((s) => s.stop_id === stopId);
          if (cur && cur.stop_name === defaultName) {
            useStore.getState().updateStop(stopId, { stop_name: name });
          }
        });
      }

      if (hasRoute && currentState.selectedRouteId) {
        const existingStops = currentState.routeStops.filter(
          (rs) => rs.route_id === currentState.selectedRouteId
            && (bestShapeId ? rs.shape_id === bestShapeId : rs.direction_id === bestDirectionId)
        );
        currentState.addRouteStop({
          route_id: currentState.selectedRouteId,
          stop_id: stopId,
          direction_id: bestDirectionId,
          stop_sequence: existingStops.length,
          _snapped: currentState.stopPlacementMode === 'snap_to_route',
          shape_id: bestShapeId,
        });
      }

      currentState.selectStop(stopId);
      // Stay in the user's current sub-panel while creating. The legacy
      // behavior of jumping to the Stops section made sense before the
      // CreateStopPanel existed; now it would yank the user out of their flow.
      // Also skip if the user is already on the Stops section — calling
      // setSidebarSection re-opens the right rail as a side-effect, which
      // un-minimizes the panel after each click while in Add Stop mode.
      if (
        !currentState.creatingStop &&
        !currentState.editingRouteId &&
        currentState.sidebarSection !== 'stops'
      ) {
        currentState.setSidebarSection('stops');
      }
      lastPlacedStopRef.current = stopId;
      return;
    }

    // Select mode
    if (currentState.mapMode === 'select') {
      // Clicked a stop cluster (large-feed clustered mode) → zoom in to expand it.
      const clusterFeature = e.features?.find((f: MapboxGeoJSONFeature) => f.layer?.id === 'stop-clusters');
      if (clusterFeature?.properties) {
        const map = mapRef.current?.getMap?.();
        const source = map?.getSource('stop-cluster') as
          | { getClusterExpansionZoom: (id: number, cb: (err: unknown, zoom: number) => void) => void }
          | undefined;
        const clusterId = clusterFeature.properties.cluster_id;
        if (map && source && typeof clusterId === 'number') {
          source.getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: [e.lngLat.lng, e.lngLat.lat], zoom, duration: 500 });
          });
        }
        return;
      }

      const stopFeature = e.features?.find((f: MapboxGeoJSONFeature) =>
        f.layer?.id === 'stop-circles' || f.layer?.id === 'stop-cluster-points');
      if (stopFeature?.properties) {
        const sid = stopFeature.properties.stop_id;
        currentState.selectStop(sid);
        setPopupStopId(sid);
        setPopupRouteId(null);
        setPopupFlexZoneId(null);
        currentState.setSidebarSection('stops');
        return;
      }

      const routeFeature = e.features?.find((f: MapboxGeoJSONFeature) => f.layer?.id === 'route-lines');
      if (routeFeature?.properties) {
        const rid = routeFeature.properties.route_id;
        const did = routeFeature.properties.direction_id;
        const sid = routeFeature.properties.shape_id;
        currentState.selectRoute(rid);
        setPopupRouteId(rid);
        setPopupDirectionId(typeof did === 'number' ? did as 0 | 1 : 0);
        setPopupShapeId(typeof sid === 'string' && sid ? sid : null);
        setPopupStopId(null);
        setPopupFlexZoneId(null);
        setPopupLngLat({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        // Don't auto-open the Routes panel on a map click — the popup is
        // enough. The user explicitly opens the editor by clicking
        // "Edit Route" in the popup, which sets editingRouteId and lands
        // them directly in the route detail view.
        return;
      }

      const flexFeature = e.features?.find((f: MapboxGeoJSONFeature) => f.layer?.id === 'flex-zone-fill');
      if (flexFeature?.properties) {
        setPopupFlexZoneId(flexFeature.properties.zoneId);
        setPopupStopId(null);
        setPopupRouteId(null);
        setPopupLngLat({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        return;
      }

      setPopupStopId(null);
      setPopupRouteId(null);
      setPopupFlexZoneId(null);
    }
  }, []);

  // Double-clicking in Add Stop mode mirrors the draw_line_string convention:
  // the gesture both commits a stop AND ends the mode. The two singletons of
  // the dblclick pair have each already fired handleMapClick (placing two
  // near-duplicate stops at the same lat/lon), so we remove the second one
  // and switch back to select. With doubleClickZoom disabled in this mode,
  // the gesture doesn't also zoom the map.
  const handleMapDblClick = useCallback((e: MapMouseEvent & { features?: MapboxGeoJSONFeature[] }) => {
    const state = useStore.getState();
    if (state.mapMode !== 'place_stop') return;
    e.preventDefault?.();
    if (lastPlacedStopRef.current) {
      const sid = lastPlacedStopRef.current;
      const sr = state.selectedRouteId;
      if (sr) {
        state.removeRouteStop(sr, sid, 0);
        state.removeRouteStop(sr, sid, 1);
      }
      state.removeStop(sid);
      lastPlacedStopRef.current = null;
    }
    state.setMapMode('select');
  }, []);

  const handleMouseMove = useCallback((e: MapMouseEvent & { features?: MapboxGeoJSONFeature[] }) => {
    if (mapMode === 'select') {
      setHoveringFeature(!!(e.features && e.features.length > 0));
      return;
    }
    if (mapMode === 'move_stop') {
      // Track whether we're hovering over a stop circle so the cursor can
      // switch to a grab affordance while in move mode. Skip updates during
      // an active drag so the cursor doesn't flicker between grab and grabbing.
      if (draggingStopRef.current) return;
      const over = !!(e.features && e.features.some((f: MapboxGeoJSONFeature) => f.layer?.id === 'stop-circles'));
      setHoveringStop(over);
    }
  }, [mapMode]);

  const handleMouseLeave = useCallback(() => {
    setHoveringFeature(false);
    setHoveringStop(false);
  }, []);

  const cursor = mapMode === 'draw_route' || mapMode === 'draw_flex_zone' ? 'crosshair'
    : mapMode === 'draw_fare_zone' || mapMode === 'select_stops_polygon' ? 'crosshair'
    : mapMode === 'place_stop' ? 'crosshair'
    : mapMode === 'trim_shape' ? 'crosshair'
    : mapMode === 'move_stop' ? (hoveringStop ? 'grab' : 'crosshair')
    : mapMode === 'edit_shape' || mapMode === 'edit_flex_zone' ? 'default'
    : hoveringFeature ? 'pointer'
    : 'grab';

  return (
    <div ref={containerRef} className="flex-1 relative min-h-0">
      <Map
        ref={mapRef}
        initialViewState={initialView}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle={mapStyleId === 'satellite'
          ? 'mapbox://styles/mapbox/satellite-streets-v12'
          : 'mapbox://styles/mapbox/light-v11'
        }
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        cursor={cursor}
        onClick={handleMapClick}
        onDblClick={handleMapDblClick}
        // Disable native zoom-on-double-click while placing stops so the
        // dblclick gesture cleanly exits the mode instead of also zooming.
        doubleClickZoom={mapMode !== 'place_stop'}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        interactiveLayerIds={mapMode === 'edit_shape' || mapMode === 'edit_flex_zone' || mapMode === 'draw_flex_zone' || mapMode === 'draw_fare_zone' || mapMode === 'select_stops_polygon' ? [] : ['stop-circles', 'stop-cluster-points', 'stop-clusters', 'route-lines', 'flex-zone-fill']}
      >
        <NavigationControl position="bottom-right" />
        <DrawControl
          drawRef={drawRef}
          onCreate={handleDrawCreate}
          onUpdate={handleDrawUpdate}
        />
        <DemandDotsLayer visible={showDemandDots} />
        <CoverageLayer />
        <FlexLayer />
        <RouteLayer simplified={simplifyShapes} />
        <StopLayer clustered={clusterStops} />
        <StopAnalysisLayer />

        {popupStopId && (
          <StopPopup
            stopId={popupStopId}
            onClose={() => setPopupStopId(null)}
          />
        )}

        {popupRouteId && popupLngLat && (
          <RoutePopup
            routeId={popupRouteId}
            directionId={popupDirectionId}
            shapeId={popupShapeId ?? undefined}
            lngLat={popupLngLat}
            onClose={() => { setPopupRouteId(null); setPopupShapeId(null); }}
          />
        )}

        {popupFlexZoneId && popupLngLat && (
          <FlexZonePopup
            zoneId={popupFlexZoneId}
            lngLat={popupLngLat}
            onClose={() => setPopupFlexZoneId(null)}
          />
        )}
      </Map>
      <MapToolbar />
      <MapLayerControls
        mapStyle={mapStyleId}
        onMapStyleChange={setMapStyleId}
        showDemandDots={showDemandDots}
        onShowDemandDotsChange={setShowDemandDots}
      />
      <DrawingIndicator />

      {/* Shape-edit top banner + inline Save Shape / Cancel buttons. Lives
          on the map (not the rail) so it's always reachable — closing the
          rail or switching tabs no longer strands the user. Banner stays
          beside the buttons in one cluster so the user reads instruction
          + action together. */}
      {mapMode === 'edit_shape' && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
          <div className="bg-coral text-white px-5 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            {editingLabel ? `Editing ${editingLabel}` : 'Editing Shape'} — Drag vertices, click midpoints to add
          </div>
          <button
            onClick={discardShapeEdit}
            className="px-4 py-2 bg-white text-warm-gray rounded-full text-[13px] font-heading font-bold shadow-md hover:bg-sand transition-colors border border-sand"
          >
            Cancel
          </button>
          <button
            onClick={saveShapeEdit}
            className="px-4 py-2 bg-coral text-white rounded-full text-[13px] font-heading font-bold shadow-md hover:bg-[#d4603a] transition-colors"
          >
            Save Shape
          </button>
        </div>
      )}

      {/* Delete Selected Vertex stays at the bottom of the map — only shows
          when the user actually has a vertex / midpoint selected in mapbox-
          gl-draw, so it doesn't sit there unreachable. */}
      {mapMode === 'edit_shape' && editVertexSelected && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={() => { if (drawRef.current) drawRef.current.trash(); }}
            className="px-4 py-2 bg-white text-red-600 rounded-full text-xs font-heading font-bold shadow-md hover:bg-red-50 transition-colors border border-red-200"
          >
            Delete Selected Vertex
          </button>
        </div>
      )}

      {/* Flex zone editing controls */}
      {mapMode === 'edit_flex_zone' && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 flex gap-2">
          <button
            onClick={() => { if (drawRef.current) drawRef.current.trash(); }}
            className="px-4 py-2 bg-white text-red-600 rounded-full text-xs font-heading font-bold shadow-md hover:bg-red-50 transition-colors border border-red-200"
          >
            Delete Vertex
          </button>
          <button
            onClick={discardFlexZoneEdit}
            className="px-4 py-2 bg-white text-warm-gray rounded-full text-xs font-heading font-bold shadow-md hover:bg-sand transition-colors border border-sand"
          >
            Cancel
          </button>
          <button
            onClick={saveFlexZoneEdit}
            className="px-4 py-2 bg-purple text-white rounded-full text-xs font-heading font-bold shadow-md hover:opacity-90 transition-opacity"
          >
            Save Zone
          </button>
        </div>
      )}

      {/* Snapping indicator */}
      {isSnapping && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-teal text-white px-5 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md z-10 animate-pulse">
          Snapping to road...
        </div>
      )}

      {/* Snap-to-road couldn't fully match the drawn shape — keep it unsnapped
          or discard and redraw (an explicit choice; no backdrop dismiss). */}
      {snapWarning && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="absolute inset-0 bg-black/20" />
          <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-sm mx-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
              Couldn&rsquo;t snap to roads
            </h3>
            <p className="text-sm text-warm-gray mb-4">
              {snapWarning.status === 'partial'
                ? 'Part of this shape couldn’t be matched to a roadway — it looks like the route passes through an area with no road, so the snapped version would be cut off there.'
                : 'This shape couldn’t be matched to any roadway.'}
              {' '}You can keep your drawn shape exactly as-is (unsnapped), or discard it and draw again.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDiscardAndRedraw}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
              >
                Discard &amp; redraw
              </button>
              <button
                onClick={handleKeepUnsnapped}
                className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
              >
                Keep unsnapped
              </button>
            </div>
          </div>
        </div>
      )}

      {/* (Shape-split confirm modal removed — replaced by Duplicate + Trim
          in the Routes Shapes subpanel.) */}

      {/* Discard shape changes confirmation */}
      {showDiscardConfirm && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="absolute inset-0 bg-black/20" onClick={() => setShowDiscardConfirm(false)} />
          <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-xs mx-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
              Discard shape changes?
            </h3>
            <p className="text-sm text-warm-gray mb-4">
              Your edits to this shape will be lost.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowDiscardConfirm(false);
                  saveShapeEdit();
                }}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
              >
                Keep Changes
              </button>
              <button
                onClick={discardShapeEdit}
                className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg font-heading font-bold text-sm hover:bg-red-600 transition-colors"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
