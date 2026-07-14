import { useEffect } from 'react';
import { useStore } from '../../store';
import { RouteEditor } from './RouteEditor';
import { RouteStopsTab } from './RouteStopsTab';
import { RouteTripsTab } from './RouteTripsTab';
import { RouteShapesTab } from './RouteShapesTab';
import { RouteCostsTab } from './RouteCostsTab';
import { RouteWalkshedProfileTab } from '../coverage/WalkshedProfilePanel';
import type { RouteDetailTab } from '../../types/ui';

type Bounds = [[number, number], [number, number]];

function expandBounds(b: Bounds | null, lng: number, lat: number): Bounds {
  if (!b) return [[lng, lat], [lng, lat]];
  return [
    [Math.min(b[0][0], lng), Math.min(b[0][1], lat)],
    [Math.max(b[1][0], lng), Math.max(b[1][1], lat)],
  ];
}

function isValidBounds(b: Bounds | null): b is Bounds {
  if (!b) return false;
  return b[0][0] !== b[1][0] || b[0][1] !== b[1][1];
}

/** Fit the map to whatever is most relevant for the current tab. */
function useFocusRouteOnMap(routeId: string | null, tab: RouteDetailTab) {
  const shapes = useStore((s) => s.shapes);
  const trips = useStore((s) => s.trips);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);

  useEffect(() => {
    if (!routeId) return;
    // RoutePopup's "Edit Shape" handoff sets this flag on window before any
    // state mutation. Honor it as a one-shot: skip this fit, then clear so
    // the next ordinary tab/route change still auto-fits. Avoids the store
    // race (RouteShapesTab clears pendingShapeEditId before this effect
    // reads it).
    if (window.__suppressNextRouteFit) {
      window.__suppressNextRouteFit = false;
      return;
    }
    const fitBounds = (window as { __mapFitBounds?: (b: Bounds, opts?: { padding?: number; maxZoom?: number }) => void })
      .__mapFitBounds;
    if (!fitBounds) return;

    let bounds: Bounds | null = null;

    if (tab === 'stops') {
      // Fit to the stops served by this route.
      const stopIds = new Set(
        routeStops.filter((rs) => rs.route_id === routeId).map((rs) => rs.stop_id),
      );
      for (const s of stops) {
        if (stopIds.has(s.stop_id)) {
          bounds = expandBounds(bounds, s.stop_lon, s.stop_lat);
        }
      }
    } else {
      // Default: fit to the route's shape geometry.
      const shapeIds = new Set(
        trips.filter((t) => t.route_id === routeId && t.shape_id).map((t) => t.shape_id!),
      );
      for (const sh of shapes) {
        if (!shapeIds.has(sh.shape_id)) continue;
        for (const p of sh.points) {
          bounds = expandBounds(bounds, p.shape_pt_lon, p.shape_pt_lat);
        }
      }
    }

    if (isValidBounds(bounds)) {
      fitBounds(bounds, { padding: 80, maxZoom: 14 });
    }
  }, [routeId, tab, shapes, trips, stops, routeStops]);
}

export function RouteDetailPanel() {
  const tab = useStore((s) => s.routeDetailTab);
  const editingRouteId = useStore((s) => s.editingRouteId);
  useFocusRouteOnMap(editingRouteId, tab);

  switch (tab) {
    case 'details':
      return <RouteEditor />;
    case 'stops':
      return <RouteStopsTab />;
    case 'trips':
      return <RouteTripsTab />;
    case 'shapes':
      return <RouteShapesTab />;
    case 'costs':
      return <RouteCostsTab />;
    case 'coverage':
      return <RouteWalkshedProfileTab />;
    default:
      return <RouteEditor />;
  }
}
