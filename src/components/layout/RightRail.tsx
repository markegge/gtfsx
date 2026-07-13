import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import type { SidebarSection, RouteDetailTab } from '../../types/ui';
import { AgencyEditor } from '../agency/AgencyEditor';
import { CalendarEditor } from '../calendar/CalendarEditor';
import { RouteList } from '../routes/RouteList';
import { requestDeleteRoute } from '../routes/requestDeleteRoute';
import { StopList } from '../stops/StopList';
import { StopEditPanel } from '../stops/StopEditPanel';
import { CreateStopPanel } from '../stops/CreateStopPanel';
import { FaresPanel } from '../fares/FaresPanel';
import { CostSummary } from '../costs/CostSummary';
import { CoveragePanel } from '../coverage/CoveragePanel';
import { TitleVIPanel } from '../titlevi/TitleVIPanel';
import { StopAnalysisPanel } from '../analysis/StopAnalysisPanel';
import { AccessIsochronePanel } from '../analysis/AccessIsochronePanel';
import { FlexEditor } from '../flex/FlexEditor';
import { deleteFlexZoneWithRoute } from '../flex/flexHelpers';
import { StationsPanel } from '../stations/StationsPanel';
import { FrequenciesEditor } from '../frequencies/FrequenciesEditor';
import { BlocksPanel } from '../blocks/BlocksPanel';
import { AlertsEditor } from '../alerts/AlertsEditor';
import { FeatureSettingsPanel } from '../settings/FeatureSettingsPanel';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';
import { EditActions } from '../ui/EditActions';
import { Breadcrumb } from '../ui/Breadcrumb';
import { TabButton } from '../ui/Tabs';

const RIGHT_RAIL_DEFAULT_WIDTH = 460;
const RIGHT_RAIL_MIN_WIDTH = 320;
const RIGHT_RAIL_MAX_WIDTH = 720;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const SECTION_TITLES: Record<SidebarSection, string> = {
  agency: 'Agency',
  calendar: 'Calendars',
  routes: 'Routes',
  stops: 'Stops',
  stations: 'Stations',
  frequencies: 'Frequencies',
  blocks: 'Blocks',
  fares: 'Fares & Transfers',
  flex: 'Flex Zones & Rules',
  costs: 'Costs',
  coverage: 'Coverage',
  titlevi: 'Title VI',
  'stop-analysis': 'Stop Analysis',
  'access-isochrones': 'Access Isochrones',
  alerts: 'Service Alerts',
  settings: 'Feature settings',
};

const SECTION_GROUP: Record<SidebarSection, string | null> = {
  agency: 'Setup',
  fares: 'Setup',
  calendar: 'Setup',
  routes: 'Fixed Route Service',
  stops: 'Fixed Route Service',
  stations: 'Fixed Route Service',
  frequencies: 'Fixed Route Service',
  blocks: 'Fixed Route Service',
  flex: 'GTFS-Flex',
  costs: 'Analysis',
  coverage: 'Analysis',
  titlevi: 'Analysis',
  'stop-analysis': 'Analysis',
  'access-isochrones': 'Analysis',
  alerts: 'Operations',
  settings: null,
};

function PanelBody({ section }: { section: SidebarSection }) {
  const plan = useEditorPlan();
  switch (section) {
    case 'agency':
      return <AgencyEditor />;
    case 'calendar':
      return <CalendarEditor />;
    case 'routes':
      return <RouteList />;
    case 'stops':
      return <StopList />;
    case 'fares':
      return <FaresPanel />;
    case 'flex':
      return <FlexEditor />;
    case 'stations':
      return <StationsPanel />;
    case 'frequencies':
      return <FrequenciesEditor />;
    case 'blocks':
      return <BlocksPanel />;
    case 'costs':
      // System cost totals are free; the per-route breakdown + CSV export are
      // gated (analysis_basic / Agency+) inside CostSummary. Keep it unwrapped.
      return <CostSummary />;
    case 'coverage':
      // System coverage summary is free; the per-route coverage is gated
      // (analysis_basic) inside CoveragePanel. Keep it unwrapped here.
      return <CoveragePanel />;
    case 'titlevi':
      return (
        <PaywallOverlay feature="analysis_title_vi" currentPlan={plan}>
          <TitleVIPanel />
        </PaywallOverlay>
      );
    case 'stop-analysis':
      return (
        <PaywallOverlay feature="analysis_basic" currentPlan={plan}>
          <StopAnalysisPanel />
        </PaywallOverlay>
      );
    case 'access-isochrones':
      return (
        <PaywallOverlay feature="access_isochrones" currentPlan={plan}>
          <AccessIsochronePanel />
        </PaywallOverlay>
      );
    case 'alerts':
      return (
        <PaywallOverlay feature="service_alerts" currentPlan={plan}>
          <AlertsEditor />
        </PaywallOverlay>
      );
    case 'settings':
      return <FeatureSettingsPanel />;
    default:
      return null;
  }
}

const ROUTE_TABS: { id: RouteDetailTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'stops', label: 'Stops' },
  { id: 'trips', label: 'Trips' },
  { id: 'costs', label: 'Costs' },
];

function RouteDetailHeader() {
  const route = useStore((s) =>
    s.routes.find((r) => r.route_id === s.editingRouteId),
  );
  const stopsCount = useStore((s) => {
    const id = s.editingRouteId;
    if (!id) return 0;
    return new Set(
      s.routeStops.filter((rs) => rs.route_id === id).map((rs) => rs.stop_id),
    ).size;
  });
  const tripsCount = useStore((s) => {
    const id = s.editingRouteId;
    if (!id) return 0;
    return s.trips.filter((t) => t.route_id === id).length;
  });
  // Count unique shape_ids referenced by this route's trips — matches what
  // RouteShapesTab actually lists. Trips without a shape_id are excluded.
  const shapesCount = useStore((s) => {
    const id = s.editingRouteId;
    if (!id) return 0;
    const ids = new Set<string>();
    for (const t of s.trips) {
      if (t.route_id === id && t.shape_id) ids.add(t.shape_id);
    }
    return ids.size;
  });
  const setEditingRouteId = useStore((s) => s.setEditingRouteId);
  const setSidebarSection = useStore((s) => s.setSidebarSection);
  const selectRoute = useStore((s) => s.selectRoute);
  const duplicateRoute = useStore((s) => s.duplicateRoute);
  const tab = useStore((s) => s.routeDetailTab);
  const setRouteDetailTab = useStore((s) => s.setRouteDetailTab);

  if (!route) return null;

  const title =
    route.route_short_name || route.route_long_name || 'Untitled Route';

  const counts: Partial<Record<RouteDetailTab, number>> = {
    shapes: shapesCount,
    stops: stopsCount,
    trips: tripsCount,
  };

  const handleDuplicate = () => {
    const newId = duplicateRoute(route.route_id);
    if (newId) {
      selectRoute(newId);
      setEditingRouteId(newId);
    }
  };

  return (
    <div className="border-b border-sand bg-white shrink-0">
      {/* Breadcrumb row */}
      <div className="px-5 pt-3 flex items-center gap-2">
        <div className="flex-1 min-w-0 text-[13px] text-warm-gray">
          <Breadcrumb
            items={[
              { label: 'Routes', onClick: () => setEditingRouteId(null) },
              { label: title, className: 'truncate' },
            ]}
          />
        </div>
        <button
          onClick={() => {
            // Fully close the rail and drop the route selection so nothing
            // stays highlighted on the map and no stale route lingers.
            setEditingRouteId(null);
            selectRoute(null);
            setSidebarSection(null);
          }}
          className="w-7 h-7 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
          title="Close editor"
        >
          ✕
        </button>
      </div>
      {/* Title row */}
      <div className="px-5 pt-1 pb-3 flex items-center gap-3">
        <div
          className="w-5 h-5 rounded-md shrink-0"
          style={{ background: `#${route.route_color}` }}
        />
        <h2 className="font-heading font-extrabold text-xl text-dark-brown leading-tight truncate flex-1 min-w-0">
          {title}
        </h2>
        <EditActions
          onDuplicate={handleDuplicate}
          onDelete={() => requestDeleteRoute(route.route_id)}
          duplicateTitle="Duplicate this route"
          deleteTitle="Delete this route"
          confirmDelete={false}
        />
      </div>
      {/* Tabs strip — scrollable on narrow viewports so all 5 tabs are reachable */}
      <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="px-3 flex items-end gap-1 -mb-px min-w-max">
          {ROUTE_TABS.map((t) => {
            const active = tab === t.id;
            const count = counts[t.id];
            return (
              <TabButton
                key={t.id}
                active={active}
                onClick={() => setRouteDetailTab(t.id)}
                className="flex items-center gap-1.5"
              >
                <span>{t.label}</span>
                {count != null && count > 0 && (
                  <span
                    className={`text-[11px] font-bold tabular-nums ${
                      active ? 'text-coral' : 'text-warm-gray'
                    }`}
                  >
                    {count.toLocaleString()}
                  </span>
                )}
              </TabButton>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Header for the stop edit sub-panel. Reads context (which route is being
 * edited, which section the user is on) to render either:
 *   Stops > {stop name}
 *   Routes > {route name} > {stop name}
 * Back navigation drops `editingStopId` and keeps the surrounding section
 * intact (route detail's Stops tab when coming from there).
 */
function StopEditHeader() {
  const stop = useStore((s) => {
    const id = s.editingStopId;
    if (!id) return null;
    return s.stops.find((x) => x.stop_id === id) ?? null;
  });
  const editingRouteId = useStore((s) => s.editingRouteId);
  const route = useStore((s) =>
    editingRouteId ? s.routes.find((r) => r.route_id === editingRouteId) : null,
  );
  const section = useStore((s) => s.sidebarSection);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const setRouteDetailTab = useStore((s) => s.setRouteDetailTab);
  const setSidebarSection = useStore((s) => s.setSidebarSection);
  const duplicateStop = useStore((s) => s.duplicateStop);
  const removeStop = useStore((s) => s.removeStop);
  const stopDetailTab = useStore((s) => s.stopDetailTab);
  const setStopDetailTab = useStore((s) => s.setStopDetailTab);
  const selectStop = useStore((s) => s.selectStop);

  if (!stop) return null;

  const stopLabel = stop.stop_name || stop.stop_id;
  const fromRouteContext = section === 'routes' && !!route;

  // Going "back" from a route-scoped edit returns to that route's Stops tab.
  // Going back from the Stops panel just clears the edit state.
  const goBack = () => {
    setEditingStopId(null);
    selectStop(null);
    if (fromRouteContext) setRouteDetailTab('stops');
  };

  return (
    <div className="px-5 py-3.5 border-b border-sand bg-white shrink-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <nav className="text-[13px] text-warm-gray">
            <button onClick={goBack} className="hover:text-coral transition-colors mr-1.5">
              ←
            </button>
            {fromRouteContext ? (
              <Breadcrumb
                items={[
                  { label: 'Routes', onClick: () => setSidebarSection('routes') },
                  {
                    label: route.route_short_name || route.route_long_name || 'Route',
                    onClick: () => { setEditingStopId(null); setRouteDetailTab('details'); },
                    className: 'truncate',
                  },
                  {
                    label: 'Stops',
                    onClick: () => { setEditingStopId(null); selectStop(null); setRouteDetailTab('stops'); },
                  },
                ]}
              />
            ) : (
              <Breadcrumb items={[{ label: 'Stops', onClick: goBack }]} />
            )}
          </nav>
          <h2 className="mt-1 font-heading font-extrabold text-lg text-dark-brown leading-tight truncate">
            {stopLabel}
          </h2>
          <p className="text-[11px] text-warm-gray">Stop ID: {stop.stop_id}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <EditActions
            onDuplicate={() => {
              const newId = duplicateStop(stop.stop_id);
              if (newId) { selectStop(newId); setEditingStopId(newId); }
            }}
            onDelete={() => { removeStop(stop.stop_id); goBack(); }}
            duplicateTitle="Duplicate this stop"
            deleteTitle="Delete this stop"
          />
          <button
            onClick={() => useStore.getState().setSidebarSection(null)}
            className="w-7 h-7 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
            title="Close editor"
          >
            ✕
          </button>
        </div>
      </div>
      {/* Details / Trips / Coverage tabs (mirrors the route editor's tab strip). */}
      <div className="flex gap-1 mt-3 -mb-3.5">
        {(['details', 'trips', 'coverage'] as const).map((t) => (
          <TabButton key={t} active={stopDetailTab === t} onClick={() => setStopDetailTab(t)}>
            {t === 'details' ? 'Details' : t === 'trips' ? 'Trips' : 'Coverage'}
          </TabButton>
        ))}
      </div>
    </div>
  );
}

/**
 * Header for the CreateStopPanel. Mirrors StopEditHeader's breadcrumb logic
 * but with a "New stop" leaf instead of a stop name, so the user can see
 * whether they're creating within a route context or standalone.
 */
function CreateStopHeader() {
  const editingRouteId = useStore((s) => s.editingRouteId);
  const route = useStore((s) =>
    editingRouteId ? s.routes.find((r) => r.route_id === editingRouteId) : null,
  );
  const section = useStore((s) => s.sidebarSection);
  const setCreatingStop = useStore((s) => s.setCreatingStop);
  const setRouteDetailTab = useStore((s) => s.setRouteDetailTab);
  const setSidebarSection = useStore((s) => s.setSidebarSection);
  const setMapMode = useStore((s) => s.setMapMode);

  const fromRouteContext = section === 'routes' && !!route;

  const goBack = () => {
    setCreatingStop(false);
    // Don't leave the map in 'place_stop' mode after closing the create panel.
    if (useStore.getState().mapMode === 'place_stop') setMapMode('select');
    if (fromRouteContext) setRouteDetailTab('stops');
  };

  return (
    <div className="px-5 py-3.5 border-b border-sand bg-white shrink-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <nav className="text-[13px] text-warm-gray">
            <button onClick={goBack} className="hover:text-coral transition-colors mr-1.5">←</button>
            {fromRouteContext && route ? (
              <Breadcrumb
                items={[
                  { label: 'Routes', onClick: () => setSidebarSection('routes') },
                  {
                    label: route.route_short_name || route.route_long_name || 'Route',
                    onClick: () => { setCreatingStop(false); setRouteDetailTab('details'); },
                    className: 'truncate',
                  },
                  { label: 'Stops', onClick: goBack },
                ]}
              />
            ) : (
              <Breadcrumb items={[{ label: 'Stops', onClick: goBack }]} />
            )}
          </nav>
          <h2 className="mt-1 font-heading font-extrabold text-lg text-dark-brown leading-tight truncate">
            New stop
          </h2>
        </div>
        <button
          onClick={() => useStore.getState().setSidebarSection(null)}
          className="w-7 h-7 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
          title="Close editor"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function CalendarDetailHeader() {
  const calendar = useStore((s) =>
    s.calendars.find((c) => c.service_id === s.editingCalendarServiceId) ?? null,
  );
  const setEditingCalendarServiceId = useStore((s) => s.setEditingCalendarServiceId);
  const duplicateCalendar = useStore((s) => s.duplicateCalendar);
  const removeCalendar = useStore((s) => s.removeCalendar);
  const calendarDetailTab = useStore((s) => s.calendarDetailTab);
  const setCalendarDetailTab = useStore((s) => s.setCalendarDetailTab);

  if (!calendar) return null;
  const title = calendar._description || calendar.service_id;

  return (
    <div className="border-b border-sand bg-white shrink-0">
      <div className="px-5 pt-3 flex items-center gap-2">
        <div className="flex-1 min-w-0 text-[13px] text-warm-gray">
          <Breadcrumb
            items={[
              { label: 'Calendars', onClick: () => setEditingCalendarServiceId(null) },
              { label: title, className: 'truncate' },
            ]}
          />
        </div>
        <button
          onClick={() => useStore.getState().setSidebarSection(null)}
          className="w-7 h-7 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
          title="Close editor"
        >
          ✕
        </button>
      </div>
      <div className="px-5 pt-1 pb-3 flex items-center gap-3">
        <h2 className="font-heading font-extrabold text-xl text-dark-brown leading-tight truncate flex-1 min-w-0">
          {title}
        </h2>
        <EditActions
          onDuplicate={() => {
            const newId = duplicateCalendar(calendar.service_id);
            if (newId) setEditingCalendarServiceId(newId);
          }}
          onDelete={() => { removeCalendar(calendar.service_id); setEditingCalendarServiceId(null); }}
          duplicateTitle="Duplicate this calendar"
          deleteTitle="Delete this calendar"
        />
      </div>
      {/* Details / Routes / Exceptions tabs — scrollable on narrow viewports */}
      <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-1 px-3 -mb-px min-w-max">
          {(['details', 'routes', 'exceptions'] as const).map((t) => (
            <TabButton key={t} active={calendarDetailTab === t} onClick={() => setCalendarDetailTab(t)}>
              {t === 'details' ? 'Details' : t === 'routes' ? 'Routes' : 'Exceptions'}
            </TabButton>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Header for the flex zone detail sub-panel. Mirrors RouteDetailHeader: a
 * breadcrumb back to the zone list, the zone name, and its Delete action.
 */
function FlexZoneDetailHeader() {
  const zone = useStore((s) =>
    s.flexZones.find((z) => z.id === s.flexZoneDetailId) ?? null,
  );
  const setFlexZoneDetailId = useStore((s) => s.setFlexZoneDetailId);
  const setSidebarSection = useStore((s) => s.setSidebarSection);

  if (!zone) return null;

  return (
    <div className="border-b border-sand bg-white shrink-0">
      {/* Breadcrumb row */}
      <div className="px-5 pt-3 flex items-center gap-2">
        <div className="flex-1 min-w-0 text-[13px] text-warm-gray">
          <Breadcrumb
            items={[
              { label: 'Flex Zones', onClick: () => setFlexZoneDetailId(null) },
              { label: zone.name, className: 'truncate' },
            ]}
          />
        </div>
        <button
          onClick={() => {
            setFlexZoneDetailId(null);
            setSidebarSection(null);
          }}
          className="w-7 h-7 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
          title="Close editor"
        >
          ✕
        </button>
      </div>
      {/* Title row */}
      <div className="px-5 pt-1 pb-3 flex items-center gap-3">
        <div
          className="w-5 h-5 rounded-md shrink-0 border border-purple-300"
          style={{ background: 'rgba(124,58,237,0.2)' }}
        />
        <h2 className="font-heading font-extrabold text-xl text-dark-brown leading-tight truncate flex-1 min-w-0">
          {zone.name}
        </h2>
        <EditActions
          onDelete={() => {
            deleteFlexZoneWithRoute(zone.id);
            setFlexZoneDetailId(null);
          }}
          deleteTitle="Delete this flex zone"
        />
      </div>
    </div>
  );
}

function GenericHeader({ section }: { section: SidebarSection }) {
  const title = SECTION_TITLES[section] ?? 'Configuration';
  const group = SECTION_GROUP[section];

  return (
    <div className="px-5 py-3.5 border-b border-sand bg-white flex items-start gap-3 shrink-0">
      <div className="flex-1 min-w-0">
        {group && (
          <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-warm-gray mb-1">
            {group}
          </div>
        )}
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate">
          {title}
        </h2>
      </div>
      <button
        onClick={() => useStore.getState().setSidebarSection(null)}
        className="w-7 h-7 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
        title="Close editor"
      >
        ✕
      </button>
    </div>
  );
}

export function RightRail() {
  const section = useStore((s) => s.sidebarSection);
  const rightRailOpen = useStore((s) => s.rightRailOpen);
  const editingRouteId = useStore((s) => s.editingRouteId);
  const editingStopId = useStore((s) => s.editingStopId);
  const editingCalendarServiceId = useStore((s) => s.editingCalendarServiceId);
  const flexZoneDetailId = useStore((s) => s.flexZoneDetailId);
  const creatingStop = useStore((s) => s.creatingStop);
  const mapMode = useStore((s) => s.mapMode);
  const storedWidth = useStore((s) => s.rightRailWidth);
  const setRightRailWidth = useStore((s) => s.setRightRailWidth);

  const widthPx = clamp(storedWidth, RIGHT_RAIL_MIN_WIDTH, RIGHT_RAIL_MAX_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  // Below this width (phones) the 320 px+ rail squeezes the map to almost
  // nothing — switch to a full-screen overlay (under the top bar) so panels
  // are usable. Same 600 px threshold the LeftRail already uses.
  const NARROW_VIEWPORT = 600;
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT,
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < NARROW_VIEWPORT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isShapeEditing =
    mapMode === 'draw_route' ||
    mapMode === 'edit_shape' ||
    mapMode === 'edit_vertices' ||
    mapMode === 'draw_flex_zone' ||
    mapMode === 'edit_flex_zone';

  const showFullRail = !!section && rightRailOpen && !isShapeEditing;

  const railSizeKey = `${showFullRail ? '1' : '0'}-${isShapeEditing ? '1' : '0'}-${widthPx}`;
  useEffect(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, [railSizeKey]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      // Rail is anchored to the right edge of the viewport, so width = (right edge) - cursorX.
      const next = clamp(window.innerWidth - ev.clientX, RIGHT_RAIL_MIN_WIDTH, RIGHT_RAIL_MAX_WIDTH);
      setRightRailWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (isShapeEditing) {
    // On narrow viewports the 36px sliver is invisible/unusable — render a
    // clearly tappable floating "Done" button at the bottom-right of the map
    // instead so the user is never stuck in a drawing mode on mobile.
    if (isNarrow) {
      return (
        <div className="fixed bottom-16 right-4 z-40 pointer-events-none">
          <button
            onClick={() => useStore.getState().setMapMode('select')}
            className="pointer-events-auto bg-white border-2 border-coral shadow-lg rounded-full px-5 py-3 flex items-center gap-2 text-sm font-heading font-bold text-coral hover:bg-coral hover:text-white active:scale-95 transition-all"
            title="Exit drawing"
          >
            <span>↩</span>
            <span>Done</span>
          </button>
        </div>
      );
    }
    return (
      <button
        onClick={() => useStore.getState().setMapMode('select')}
        className="shrink-0 w-9 bg-white border-l border-sand flex flex-col items-center justify-center hover:bg-cream transition-colors group"
        title="Exit drawing & reopen editor"
      >
        <span className="text-warm-gray group-hover:text-coral text-lg font-bold leading-none">‹</span>
        <span className="mt-1.5 text-[18px] leading-none">↩</span>
      </button>
    );
  }

  // No section selected → no rail at all (let the map breathe).
  if (!section) {
    return null;
  }

  // Section selected but rail closed: render the reopen strip so the user can
  // snap back to the same section without re-clicking the left rail.
  // On narrow viewports the strip just eats space — the user reopens via the
  // left rail's section icon, which is anchored on mobile already.
  if (!rightRailOpen) {
    if (isNarrow) return null;
    const sectionTitle = SECTION_TITLES[section] ?? 'Editor';
    return (
      <button
        onClick={() => useStore.getState().setRightRailOpen(true)}
        className="shrink-0 w-9 bg-white border-l border-sand flex flex-col items-center justify-start pt-3 hover:bg-cream transition-colors group"
        title={`Open ${sectionTitle} editor`}
      >
        <span className="text-warm-gray group-hover:text-coral text-base font-bold leading-none">‹</span>
        <span
          className="mt-2 text-[10px] font-bold uppercase tracking-[0.08em] text-warm-gray group-hover:text-coral whitespace-nowrap"
          style={{ writingMode: 'vertical-rl' }}
        >
          {sectionTitle}
        </span>
      </button>
    );
  }

  const inRouteDetail = section === 'routes' && !!editingRouteId;
  const inCalendarDetail = section === 'calendar' && !!editingCalendarServiceId;
  const inFlexDetail = section === 'flex' && !!flexZoneDetailId;
  const editingStop = !!editingStopId;
  const creatingNewStop = !!creatingStop;

  return (
    <aside
      className={
        isNarrow
          // On phones, take the whole space under the top bar so the panel is
          // actually usable. z-20 so the always-visible BottomPanel header
          // (fixed z-30) stays reachable above this overlay — no dead-end.
          ? 'fixed top-14 inset-x-0 bottom-0 z-20 bg-white border-l border-sand flex flex-col overflow-hidden'
          : `relative shrink-0 bg-white border-l border-sand flex flex-col overflow-hidden ${
              isDragging ? '' : 'transition-[width] duration-150'
            }`
      }
      style={isNarrow ? undefined : { width: widthPx }}
    >
      {/* Drag-to-resize handle — desktop only (no mouse on phones). */}
      {!isNarrow && <div
        onMouseDown={startDrag}
        onDoubleClick={() => setRightRailWidth(RIGHT_RAIL_DEFAULT_WIDTH)}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor rail"
        title="Drag to resize · double-click to reset"
        className={`absolute top-0 left-0 h-full w-1.5 cursor-col-resize z-10 transition-colors ${
          isDragging ? 'bg-coral/40' : 'bg-transparent hover:bg-coral/20'
        }`}
      />}
      {isDragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      {creatingNewStop
        ? <CreateStopHeader />
        : editingStop
          ? <StopEditHeader />
          : inRouteDetail
            ? <RouteDetailHeader />
            : inCalendarDetail
              ? <CalendarDetailHeader />
              : inFlexDetail
                ? <FlexZoneDetailHeader />
                : <GenericHeader section={section} />}
      <div className="flex-1 overflow-y-auto">
        <div className="p-5">
          {creatingNewStop
            ? <CreateStopPanel />
            : editingStop
              ? <StopEditPanel />
              : <PanelBody section={section} />}
        </div>
      </div>
    </aside>
  );
}
