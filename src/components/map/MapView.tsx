import { useCallback, useRef, useMemo, useEffect, useState } from 'react';
import Map, { NavigationControl } from 'react-map-gl/mapbox';
import type MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useStore } from '../../store';
import { DrawControl } from './DrawControl';
import { RouteLayer } from './RouteLayer';
import { StopLayer } from './StopLayer';
import { MapToolbar } from './MapToolbar';
import { DrawingIndicator } from './DrawingIndicator';
import { StopPopup } from './StopPopup';
import { RoutePopup } from './RoutePopup';
import { CoverageLayer } from './CoverageLayer';
import { generateId } from '../../services/idGenerator';
import { snapToRoad } from '../../services/snapToRoad';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import distance from '@turf/distance';
import { lineString, point } from '@turf/helpers';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

export function MapView() {
  const drawRef = useRef<MapboxDraw | null>(null);
  const store = useStore();
  const {
    mapMode, setMapMode, stopPlacementMode,
    selectedRouteId, selectRoute, selectStop,
    shapes, updateShapePoints, recalcShapeDistances,
    stops, addStop, removeStop,
    routeStops, addRouteStop, removeRouteStop,
    trips,
    setDrawingRouteId,
    editingShapeId, setEditingShapeId,
    setSidebarSection,
  } = store;

  // Popup state
  const [popupStopId, setPopupStopId] = useState<string | null>(null);
  const [popupRouteId, setPopupRouteId] = useState<string | null>(null);
  const [popupLngLat, setPopupLngLat] = useState<{ lng: number; lat: number } | null>(null);

  const [isSnapping, setIsSnapping] = useState(false);

  // Track the last stop placed (for ESC undo)
  const lastPlacedStopRef = useRef<string | null>(null);
  // Track the draw feature ID for shape editing
  const editDrawFeatureIdRef = useRef<string | null>(null);
  // Snapshot of original shape points before editing (for discard)
  const originalShapePointsRef = useRef<any[] | null>(null);
  // Confirm discard dialog
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Compute initial view from stops or shapes
  const initialView = useMemo(() => {
    const allLats: number[] = [];
    const allLons: number[] = [];
    stops.forEach((s) => { allLats.push(s.stop_lat); allLons.push(s.stop_lon); });
    shapes.forEach((s) => s.points.forEach((p) => { allLats.push(p.shape_pt_lat); allLons.push(p.shape_pt_lon); }));

    if (allLats.length > 0) {
      return {
        latitude: (Math.min(...allLats) + Math.max(...allLats)) / 2,
        longitude: (Math.min(...allLons) + Math.max(...allLons)) / 2,
        zoom: 12,
      };
    }
    return { latitude: 45.68, longitude: -111.05, zoom: 12 };
  }, [stops.length === 0 && shapes.length === 0]);

  // ESC key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mapMode === 'place_stop') {
          if (lastPlacedStopRef.current) {
            const sid = lastPlacedStopRef.current;
            if (selectedRouteId) {
              removeRouteStop(selectedRouteId, sid, 0);
              removeRouteStop(selectedRouteId, sid, 1);
            }
            removeStop(sid);
            lastPlacedStopRef.current = null;
          }
          setMapMode('select');
          return;
        }
        if (mapMode === 'draw_route') {
          if (drawRef.current) drawRef.current.deleteAll();
          setMapMode('select');
          setDrawingRouteId(null);
          return;
        }
        if (mapMode === 'edit_shape') {
          // Prompt user to discard or keep changes
          setShowDiscardConfirm(true);
          return;
        }
        setPopupStopId(null);
        setPopupRouteId(null);
      }
      // Delete key removes selected vertex in edit_shape mode (handled by mapbox-gl-draw natively)
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mapMode, selectedRouteId, setMapMode, setDrawingRouteId, removeStop, removeRouteStop, editingShapeId]);

  const finishShapeEdit = useCallback(() => {
    if (drawRef.current && editingShapeId) {
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
          updateShapePoints(editingShapeId, points);
          recalcShapeDistances(editingShapeId);
        }
      }
      drawRef.current.deleteAll();
    }
    editDrawFeatureIdRef.current = null;
    // Clear snapshot BEFORE clearing editingShapeId so the cancel-detection effect doesn't restore
    originalShapePointsRef.current = null;
    setEditingShapeId(null);
    setMapMode('select');
  }, [editingShapeId, updateShapePoints, recalcShapeDistances, setEditingShapeId, setMapMode]);

  const discardShapeEdit = useCallback(() => {
    if (editingShapeId && originalShapePointsRef.current) {
      // Restore original shape points
      updateShapePoints(editingShapeId, originalShapePointsRef.current);
      recalcShapeDistances(editingShapeId);
    }
    if (drawRef.current) drawRef.current.deleteAll();
    editDrawFeatureIdRef.current = null;
    originalShapePointsRef.current = null;
    setEditingShapeId(null);
    setMapMode('select');
    setShowDiscardConfirm(false);
  }, [editingShapeId, updateShapePoints, recalcShapeDistances, setEditingShapeId, setMapMode]);

  // Track previous editingShapeId to detect Cancel (external clear without finishShapeEdit)
  const prevEditingShapeIdRef = useRef<string | null>(null);
  useEffect(() => {
    // If we were editing and editingShapeId was cleared externally (not via finishShapeEdit),
    // that means Cancel was pressed — restore original points
    if (prevEditingShapeIdRef.current && !editingShapeId && originalShapePointsRef.current) {
      updateShapePoints(prevEditingShapeIdRef.current, originalShapePointsRef.current);
      recalcShapeDistances(prevEditingShapeIdRef.current);
      originalShapePointsRef.current = null;
      if (drawRef.current) drawRef.current.deleteAll();
      editDrawFeatureIdRef.current = null;
    }
    prevEditingShapeIdRef.current = editingShapeId;
  }, [editingShapeId]);

  // Load shape into draw when entering edit_shape mode
  useEffect(() => {
    if (!drawRef.current) return;

    if (mapMode === 'edit_shape' && editingShapeId) {
      const shape = shapes.find((s) => s.shape_id === editingShapeId);
      if (!shape) return;

      // Snapshot original points for discard
      originalShapePointsRef.current = JSON.parse(JSON.stringify(shape.points));

      // Clear any existing draw features
      drawRef.current.deleteAll();

      // Add the shape as a LineString feature
      const feature: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: { shape_id: editingShapeId },
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
    } else if (mapMode === 'draw_route') {
      drawRef.current.changeMode('draw_line_string');
    } else if (mapMode !== 'edit_shape') {
      try { drawRef.current.changeMode('simple_select'); } catch {}
    }
  }, [mapMode, editingShapeId]);

  const handleDrawCreate = useCallback((e: any) => {
    const feature = e.features[0];
    if (!feature) return;

    // Read current state directly to avoid stale closures
    const currentState = useStore.getState();
    const currentDrawingRouteId = currentState.drawingRouteId;
    const currentSnapToRoad = currentState.snapToRoad;

    if (feature.geometry.type === 'LineString' && currentDrawingRouteId) {
      const rawCoords: [number, number][] = feature.geometry.coordinates;

      const createShapeFromCoords = (coords: [number, number][]) => {
        const shapeId = generateId('shape');
        const points = coords.map((c, i) => ({
          shape_pt_lat: c[1],
          shape_pt_lon: c[0],
          shape_pt_sequence: i,
          shape_dist_traveled: 0,
        }));
        const st = useStore.getState();
        st.addShape({ shape_id: shapeId, points });
        st.recalcShapeDistances(shapeId);

        const tripId = generateId('trip');
        st.addTrip({
          trip_id: tripId,
          route_id: currentDrawingRouteId,
          service_id: st.calendars[0]?.service_id || 'service-1',
          direction_id: 0,
          shape_id: shapeId,
          trip_headsign: '',
        });
      };

      if (drawRef.current) drawRef.current.deleteAll();

      if (currentSnapToRoad) {
        setIsSnapping(true);
        snapToRoad(rawCoords)
          .then((snappedCoords) => {
            createShapeFromCoords(snappedCoords);
          })
          .catch(() => {
            createShapeFromCoords(rawCoords);
          })
          .finally(() => {
            setIsSnapping(false);
            useStore.getState().setMapMode('select');
            useStore.getState().setDrawingRouteId(null);
          });
      } else {
        createShapeFromCoords(rawCoords);
        useStore.getState().setMapMode('select');
        useStore.getState().setDrawingRouteId(null);
      }
    }
  }, []); // No dependencies needed — reads directly from store

  const handleDrawUpdate = useCallback((e: any) => {
    // During edit_shape mode, updates happen in real-time as vertices are dragged
    if (mapMode === 'edit_shape' && editingShapeId) {
      const feature = e.features[0];
      if (!feature || feature.geometry.type !== 'LineString') return;
      const coords = feature.geometry.coordinates;
      const points = coords.map((c: number[], i: number) => ({
        shape_pt_lat: c[1],
        shape_pt_lon: c[0],
        shape_pt_sequence: i,
        shape_dist_traveled: 0,
      }));
      updateShapePoints(editingShapeId, points);
      recalcShapeDistances(editingShapeId);
    }
  }, [mapMode, editingShapeId, updateShapePoints, recalcShapeDistances]);

  const handleMapClick = useCallback((e: any) => {
    // Don't handle map clicks during shape editing — let draw handle it
    if (mapMode === 'edit_shape') return;

    // Stop placement mode
    if (mapMode === 'place_stop' && selectedRouteId) {
      const clickLat = e.lngLat.lat;
      const clickLon = e.lngLat.lng;
      let stopLat = clickLat;
      let stopLon = clickLon;
      let bestDirectionId: 0 | 1 = 0;

      if (stopPlacementMode === 'snap_to_route') {
        const routeTrips = trips.filter((t) => t.route_id === selectedRouteId);
        const shapeTrips = routeTrips.filter((t) => t.shape_id);
        let bestDist = Infinity;

        for (const trip of shapeTrips) {
          const shape = shapes.find((s) => s.shape_id === trip.shape_id);
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
          }
        }
      }

      const stopId = generateId('stop');
      addStop({
        stop_id: stopId,
        stop_name: `Stop ${stops.length + 1}`,
        stop_lat: stopLat,
        stop_lon: stopLon,
        location_type: 0,
        wheelchair_boarding: 0,
      });

      const existingStops = routeStops.filter(
        (rs) => rs.route_id === selectedRouteId && rs.direction_id === bestDirectionId
      );
      addRouteStop({
        route_id: selectedRouteId,
        stop_id: stopId,
        direction_id: bestDirectionId,
        stop_sequence: existingStops.length,
        _snapped: stopPlacementMode === 'snap_to_route',
      });

      selectStop(stopId);
      lastPlacedStopRef.current = stopId;
      return;
    }

    // Select mode
    if (mapMode === 'select') {
      const stopFeature = e.features?.find((f: any) => f.layer?.id === 'stop-circles');
      if (stopFeature) {
        const sid = stopFeature.properties.stop_id;
        selectStop(sid);
        setPopupStopId(sid);
        setPopupRouteId(null);
        setSidebarSection('stops');
        return;
      }

      const routeFeature = e.features?.find((f: any) => f.layer?.id === 'route-lines');
      if (routeFeature) {
        const rid = routeFeature.properties.route_id;
        selectRoute(rid);
        setPopupRouteId(rid);
        setPopupStopId(null);
        setPopupLngLat({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        setSidebarSection('routes');
        return;
      }

      setPopupStopId(null);
      setPopupRouteId(null);
    }
  }, [mapMode, selectedRouteId, stopPlacementMode, stops, shapes, trips, routeStops, addStop, addRouteStop, selectStop, selectRoute, setSidebarSection]);

  const cursor = mapMode === 'draw_route' ? 'crosshair'
    : mapMode === 'place_stop' ? 'crosshair'
    : mapMode === 'edit_shape' ? 'default'
    : 'grab';

  return (
    <div className="flex-1 relative min-h-0">
      <Map
        initialViewState={initialView}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle="mapbox://styles/mapbox/light-v11"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        cursor={cursor}
        onClick={handleMapClick}
        interactiveLayerIds={mapMode === 'edit_shape' ? [] : ['stop-circles', 'route-lines']}
      >
        <NavigationControl position="bottom-right" />
        <DrawControl
          drawRef={drawRef}
          onCreate={handleDrawCreate}
          onUpdate={handleDrawUpdate}
        />
        <CoverageLayer />
        <RouteLayer />
        <StopLayer />

        {popupStopId && (
          <StopPopup
            stopId={popupStopId}
            onClose={() => setPopupStopId(null)}
          />
        )}

        {popupRouteId && popupLngLat && (
          <RoutePopup
            routeId={popupRouteId}
            lngLat={popupLngLat}
            onClose={() => setPopupRouteId(null)}
          />
        )}
      </Map>
      <MapToolbar />
      <DrawingIndicator />

      {/* Snapping to road indicator */}
      {isSnapping && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2 bg-dark-brown text-white rounded-lg shadow-lg font-heading font-bold text-sm animate-pulse">
          Snapping to road...
        </div>
      )}

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
                  finishShapeEdit();
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
