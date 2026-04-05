import { useCallback, useRef, useMemo, useEffect, useState } from 'react';
import Map, { NavigationControl, type MapRef } from 'react-map-gl/mapbox';
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
import { DensityHeatmap } from './DensityHeatmap';
import { FlexLayer } from '../flex/FlexLayer';
import { MapLayerControls } from './MapLayerControls';
import type { MapStyleId, HeatmapMetric } from './MapLayerControls';
import { generateId } from '../../services/idGenerator';
import { snapToRoad } from '../../services/snapToRoad';
import { simplifyShapePoints } from '../../services/simplifyShape';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import distance from '@turf/distance';
import { lineString, point } from '@turf/helpers';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

export function MapView() {
  const mapRef = useRef<MapRef | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  // Only destructure values used for rendering; handlers read from useStore.getState() directly
  const mapMode = useStore((s) => s.mapMode);
  const editingShapeId = useStore((s) => s.editingShapeId);
  const editingFlexZoneId = useStore((s) => s.editingFlexZoneId);
  const stops = useStore((s) => s.stops);
  const shapes = useStore((s) => s.shapes);

  // Popup state
  const [popupStopId, setPopupStopId] = useState<string | null>(null);
  const [popupRouteId, setPopupRouteId] = useState<string | null>(null);
  const [popupLngLat, setPopupLngLat] = useState<{ lng: number; lat: number } | null>(null);
  const [popupDirectionId, setPopupDirectionId] = useState<0 | 1>(0);

  // Track the last stop placed (for ESC undo)
  const lastPlacedStopRef = useRef<string | null>(null);
  // Track the draw feature ID for shape/zone editing
  const editDrawFeatureIdRef = useRef<string | null>(null);
  // Snapshot of original shape points before editing (for discard)
  const originalShapePointsRef = useRef<any[] | null>(null);
  // Snapshot of original flex zone geojson before editing (for discard)
  const originalFlexZoneGeojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  // Confirm discard dialog
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Snapping indicator
  const [isSnapping, setIsSnapping] = useState(false);
  // Map layer controls
  const [mapStyleId, setMapStyleId] = useState<MapStyleId>('light');
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>('off');
  // Cursor: pointer when hovering over a clickable feature in select mode
  const [hoveringFeature, setHoveringFeature] = useState(false);
  // Stop dragging state
  const draggingStopRef = useRef<string | null>(null);
  const didDragStopRef = useRef(false);
  const [isDraggingStop, setIsDraggingStop] = useState(false);

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
        if (currentMode === 'draw_route') {
          e.preventDefault();
          e.stopPropagation();
          if (drawRef.current) {
            // Try to undo the last placed vertex instead of deleting the whole line
            const all = drawRef.current.getAll();
            const feature = all.features[0];
            if (feature && feature.geometry.type === 'LineString') {
              const coords = feature.geometry.coordinates;
              // coords includes the cursor position as the last element during drawing,
              // so >2 means at least 1 user-placed point + cursor
              if (coords.length > 2) {
                // Remove the last placed point (second to last; last is cursor)
                coords.splice(coords.length - 2, 1);
                drawRef.current.set(all);
                return; // Stay in draw mode
              }
            }
            // No points left or couldn't undo — cancel drawing entirely
            drawRef.current.deleteAll();
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

  // Expose map flyTo on window for sidebar components
  useEffect(() => {
    (window as any).__mapFlyTo = (lng: number, lat: number, zoom?: number) => {
      mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? mapRef.current.getZoom(), duration: 500 });
    };
    return () => { delete (window as any).__mapFlyTo; };
  }, []);

  // Expose save/discard on window so RouteEditor / FlexEditor can call them
  useEffect(() => {
    (window as any).__shapeEditSave = saveShapeEdit;
    (window as any).__shapeEditDiscard = discardShapeEdit;
    (window as any).__flexZoneEditSave = saveFlexZoneEdit;
    (window as any).__flexZoneEditDiscard = discardFlexZoneEdit;
    return () => {
      delete (window as any).__shapeEditSave;
      delete (window as any).__shapeEditDiscard;
      delete (window as any).__flexZoneEditSave;
      delete (window as any).__flexZoneEditDiscard;
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
    } else if (currentMode === 'draw_flex_zone') {
      drawRef.current.deleteAll();
      drawRef.current.changeMode('draw_polygon');
    } else if (currentMode === 'draw_route') {
      drawRef.current.changeMode('draw_line_string');
    } else if (currentMode === 'select') {
      try { drawRef.current.changeMode('simple_select'); } catch { /* ignore */ }
    }
  }, [mapMode, editingShapeId, editingFlexZoneId]);

  // Stop dragging via native map events
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const onMouseDown = (e: any) => {
      const state = useStore.getState();
      if (state.mapMode !== 'select') return;
      if (!state.selectedStopId) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['stop-circles'] });
      if (features.length === 0) return;
      const stopId = features[0].properties?.stop_id;
      // Only allow dragging the currently selected stop
      if (stopId !== state.selectedStopId) return;

      e.preventDefault();
      draggingStopRef.current = stopId;
      setIsDraggingStop(true);
      map.getCanvas().style.cursor = 'grabbing';
      map.dragPan.disable();
    };

    const onMouseMove = (e: any) => {
      if (!draggingStopRef.current) return;
      didDragStopRef.current = true;
      const stopId = draggingStopRef.current;
      useStore.getState().updateStop(stopId, {
        stop_lat: e.lngLat.lat,
        stop_lon: e.lngLat.lng,
      });
    };

    const onMouseUp = () => {
      if (!draggingStopRef.current) return;
      draggingStopRef.current = null;
      setIsDraggingStop(false);
      map.getCanvas().style.cursor = '';
      map.dragPan.enable();
      // Clear the drag flag after a tick so the click handler can check it
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

  const handleDrawCreate = useCallback((e: any) => {
    const feature = e.features[0];
    if (!feature) return;

    const currentState = useStore.getState();

    // Flex zone drawn — save as new zone
    if (currentState.mapMode === 'draw_flex_zone' && feature.geometry.type === 'Polygon') {
      const geojson: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [feature] };
      const zoneNum = currentState.flexZones.length + 1;
      currentState.addFlexZone({
        id: `flex-zone-${Date.now()}`,
        name: `Zone ${zoneNum}`,
        bufferMiles: 0,
        geojson,
      });
      useStore.getState().setMapMode('select');
      if (drawRef.current) drawRef.current.deleteAll();
      return;
    }

    const currentDrawingRouteId = currentState.drawingRouteId;
    const currentSnapToRoad = currentState.snapToRoad;

    if (feature.geometry.type === 'LineString' && currentDrawingRouteId) {
      const rawCoords: [number, number][] = feature.geometry.coordinates;

      // Read the drawing direction from window (set by RouteEditor)
      const drawingDirection: 0 | 1 = (window as any).__drawingDirection ?? 0;

      const createShapeFromCoords = (coords: [number, number][]) => {
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

        const route = st.routes.find((r) => r.route_id === currentDrawingRouteId);
        const routeName = route?.route_short_name || route?.route_long_name || '';
        const serviceId = st.calendars[0]?.service_id || 'service-1';
        const svcIdx = st.calendars.findIndex((c) => c.service_id === serviceId) + 1 || 1;
        const prefix = (routeName || 'trip').replace(/\s+/g, '').slice(0, 4).toLowerCase();
        const existingIds = new Set(st.trips.map((t) => t.trip_id));
        let tripId = `${svcIdx}${prefix}_new`;
        if (existingIds.has(tripId)) { let s = 2; while (existingIds.has(`${tripId}${s}`)) s++; tripId = `${tripId}${s}`; }
        st.addTrip({
          trip_id: tripId,
          route_id: currentDrawingRouteId,
          service_id: serviceId,
          direction_id: drawingDirection,
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
  }, []);

  const handleDrawUpdate = useCallback((e: any) => {
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

  const handleMapClick = useCallback((e: any) => {
    // Ignore clicks that are the end of a stop drag
    if (didDragStopRef.current) return;

    const currentState = useStore.getState();

    // Don't handle map clicks during shape editing
    if (currentState.mapMode === 'edit_shape') return;

    // Stop placement mode
    if (currentState.mapMode === 'place_stop' && currentState.selectedRouteId) {
      const clickLat = e.lngLat.lat;
      const clickLon = e.lngLat.lng;
      let stopLat = clickLat;
      let stopLon = clickLon;
      let bestDirectionId: 0 | 1 = currentState.stopPlacementDirection;

      if (currentState.stopPlacementMode === 'snap_to_route') {
        const routeTrips = currentState.trips.filter((t) => t.route_id === currentState.selectedRouteId);
        const shapeTrips = routeTrips.filter((t) => t.shape_id);
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
          }
        }
      }

      const stopId = generateId('stop');
      currentState.addStop({
        stop_id: stopId,
        stop_name: `Stop ${currentState.stops.length + 1}`,
        stop_lat: stopLat,
        stop_lon: stopLon,
        location_type: 0,
        wheelchair_boarding: 0,
      });

      const existingStops = currentState.routeStops.filter(
        (rs) => rs.route_id === currentState.selectedRouteId && rs.direction_id === bestDirectionId
      );
      currentState.addRouteStop({
        route_id: currentState.selectedRouteId,
        stop_id: stopId,
        direction_id: bestDirectionId,
        stop_sequence: existingStops.length,
        _snapped: currentState.stopPlacementMode === 'snap_to_route',
      });

      currentState.selectStop(stopId);
      lastPlacedStopRef.current = stopId;
      return;
    }

    // Select mode
    if (currentState.mapMode === 'select') {
      const stopFeature = e.features?.find((f: any) => f.layer?.id === 'stop-circles');
      if (stopFeature) {
        const sid = stopFeature.properties.stop_id;
        currentState.selectStop(sid);
        setPopupStopId(sid);
        setPopupRouteId(null);
        currentState.setSidebarSection('stops');
        return;
      }

      const routeFeature = e.features?.find((f: any) => f.layer?.id === 'route-lines');
      if (routeFeature) {
        const rid = routeFeature.properties.route_id;
        const did = routeFeature.properties.direction_id;
        currentState.selectRoute(rid);
        setPopupRouteId(rid);
        setPopupDirectionId(typeof did === 'number' ? did as 0 | 1 : 0);
        setPopupStopId(null);
        setPopupLngLat({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        currentState.setSidebarSection('routes');
        return;
      }

      setPopupStopId(null);
      setPopupRouteId(null);
    }
  }, []);

  const handleMouseMove = useCallback((e: any) => {
    if (mapMode !== 'select') return;
    setHoveringFeature(!!(e.features && e.features.length > 0));
  }, [mapMode]);

  const handleMouseLeave = useCallback(() => {
    setHoveringFeature(false);
  }, []);

  const cursor = isDraggingStop ? 'grabbing'
    : mapMode === 'draw_route' || mapMode === 'draw_flex_zone' ? 'crosshair'
    : mapMode === 'place_stop' ? 'crosshair'
    : mapMode === 'edit_shape' || mapMode === 'edit_flex_zone' ? 'default'
    : hoveringFeature ? 'pointer'
    : 'grab';

  return (
    <div className="flex-1 relative min-h-0">
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
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        interactiveLayerIds={mapMode === 'edit_shape' || mapMode === 'edit_flex_zone' || mapMode === 'draw_flex_zone' ? [] : ['stop-circles', 'route-lines']}
      >
        <NavigationControl position="bottom-right" />
        <DrawControl
          drawRef={drawRef}
          onCreate={handleDrawCreate}
          onUpdate={handleDrawUpdate}
        />
        <DensityHeatmap visible={heatmapMetric !== 'off'} metric={heatmapMetric === 'off' ? 'population' : heatmapMetric} />
        <CoverageLayer />
        <FlexLayer />
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
            directionId={popupDirectionId}
            lngLat={popupLngLat}
            onClose={() => setPopupRouteId(null)}
          />
        )}
      </Map>
      <MapToolbar />
      <MapLayerControls
        mapStyle={mapStyleId}
        onMapStyleChange={setMapStyleId}
        heatmapMetric={heatmapMetric}
        onHeatmapMetricChange={setHeatmapMetric}
      />
      <DrawingIndicator />

      {/* Delete vertex / save buttons — shape editing */}
      {mapMode === 'edit_shape' && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 flex gap-2">
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
