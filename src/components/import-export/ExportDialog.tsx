import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { flexZoneHasGroup, flexZoneHasPolygons } from '../../store/flexSlice';
import { exportGtfsZip, downloadBlob } from '../../services/gtfsExport';
import { exportFeedGeoJSON, feedHasGeoJSONGeometry } from '../../services/geojsonExport';
import { runValidation } from '../../services/validation';
import { trackFeedExported } from '../../services/trackBeacon';
import { useProNudge } from '../billing/useProNudge';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature, cheapestPlanFor, planDisplayName } from '../billing/planConfig';
import { Badge } from '../ui/Badge';

interface ExportDialogProps {
  onClose: () => void;
}

export function ExportDialog({ onClose }: ExportDialogProps) {
  const [exporting, setExporting] = useState(false);
  const [warningsExpanded, setWarningsExpanded] = useState(false);
  const fireNudge = useProNudge();
  const navigate = useNavigate();
  const state = useStore();
  const [fileName, setFileName] = useState(
    () => state.projectName.replace(/\s+/g, '_').toLowerCase()
  );
  // GeoJSON export is free on every plan (geojson_export feature) — the gate
  // below stays for safety if the matrix ever changes; a locked user is routed
  // to /pricing for the feature.
  const plan = useEditorPlan();
  const canGeoExport = planHasFeature(plan, 'geojson_export');
  const geoTargetPlan = planDisplayName(cheapestPlanFor('geojson_export'));
  const hasGeoGeometry = feedHasGeoJSONGeometry(state);

  const messages = runValidation(state);
  const errors = messages.filter((m) => m.severity === 'error');
  const warnings = messages.filter((m) => m.severity === 'warning');
  const hasErrors = errors.length > 0;

  // Check if errors are orphan references that can be auto-fixed
  const hasOrphanErrors = errors.some((e) =>
    e.message.includes('references non-existent route') ||
    e.message.includes('references non-existent calendar') ||
    e.message.includes('references non-existent stop')
  );

  const handleCleanOrphans = useCallback(() => {
    const s = useStore.getState();
    const routeIds = new Set(s.routes.map((r) => r.route_id));
    const stopIds = new Set(s.stops.map((st) => st.stop_id));

    // Only remove trips referencing routes that no longer exist.
    // Never remove trips just because their calendar is missing — keep
    // shapes and routes intact even without timetables.
    const validTrips = s.trips.filter((t) => routeIds.has(t.route_id));
    const removedTripIds = new Set(
      s.trips.filter((t) => !routeIds.has(t.route_id)).map((t) => t.trip_id),
    );

    // Remove stop_times for removed trips, and those referencing deleted stops
    const validStopTimes = s.stopTimes.filter(
      (st) => !removedTripIds.has(st.trip_id) && stopIds.has(st.stop_id),
    );

    // Remove fare rules referencing deleted routes
    const validFareRules = s.fareRules.filter(
      (fr) => !fr.route_id || routeIds.has(fr.route_id),
    );

    // Remove orphan routeStops (route deleted)
    const validRouteStops = s.routeStops.filter((rs) => routeIds.has(rs.route_id));

    // Never delete shapes — they are user-created geometry and should persist
    // even if no trip currently references them.

    s.setTrips(validTrips);
    s.setStopTimes(validStopTimes);
    s.setRouteStops(validRouteStops);
    if (validFareRules.length !== s.fareRules.length) {
      for (const fr of s.fareRules) {
        if (fr.route_id && !routeIds.has(fr.route_id)) {
          s.removeFareRule(fr.fare_id, fr.route_id);
        }
      }
    }
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportGtfsZip();
      const name = fileName.trim() || state.projectName.replace(/\s+/g, '_').toLowerCase();
      downloadBlob(blob, `${name}.zip`);
      // The export succeeded and the download fired — record it (best-effort).
      trackFeedExported();
      // Publish/hosting-intent nudge: a free user just produced the artifact —
      // exactly the moment to offer stable hosting. Shows a one-time toast and
      // records the pro-intent signal (no-op for paid plans and logged-out).
      fireNudge('publish_intent', 'export_zip');
      // Update project name to match exported filename
      if (fileName.trim() && fileName.trim() !== state.projectName.replace(/\s+/g, '_').toLowerCase()) {
        useStore.getState().setProjectName(fileName.trim());
      }
      onClose();
    } finally {
      setExporting(false);
    }
  };

  // GeoJSON export (free on every plan). A plan without the feature is routed
  // to /pricing instead of downloading. Geometry-only, so it's allowed even
  // when the feed has validation errors that would block the GTFS .zip.
  const handleExportGeoJSON = () => {
    const s = useStore.getState();
    if (!canGeoExport) {
      navigate(
        s.currentUser
          ? '/pricing?feature=geojson_export'
          : `/signup?next=${encodeURIComponent('/pricing?feature=geojson_export')}`,
      );
      return;
    }
    const name = fileName.trim() || s.projectName.replace(/\s+/g, '_').toLowerCase();
    exportFeedGeoJSON(s, name);
    trackFeedExported();
    if (fileName.trim() && fileName.trim() !== s.projectName.replace(/\s+/g, '_').toLowerCase()) {
      s.setProjectName(fileName.trim());
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-3 shrink-0">
          <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">Export GTFS Feed</h3>
          <p className="text-xs text-warm-gray">Your feed will be exported as a ZIP file</p>
        </div>

        {/* Scrollable body — keeps the modal on-screen when there are many
            warnings or a long file list. Header + action buttons stay fixed. */}
        <div className="flex-1 overflow-y-auto px-6 pt-1">
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            File Name
          </label>
          <div className="flex items-center gap-1">
            <input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="flex-1 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
            />
            <span className="text-sm text-warm-gray">.zip</span>
          </div>
        </div>

        {/* Validation summary */}
        <div className="flex gap-2 mb-4">
          {errors.length > 0 && <Badge variant="error">{errors.length} Errors</Badge>}
          {warnings.length > 0 && <Badge variant="warning">{warnings.length} Warnings</Badge>}
          {errors.length === 0 && warnings.length === 0 && <Badge variant="success">All checks passed</Badge>}
        </div>

        {hasErrors && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
            <p className="font-semibold text-sm text-red-700 mb-1">Fix errors before exporting</p>
            {errors.slice(0, 5).map((e) => (
              <p key={e.id} className="text-xs text-red-600">• {e.message}</p>
            ))}
            {errors.length > 5 && <p className="text-xs text-red-400">...and {errors.length - 5} more</p>}
            {hasOrphanErrors && (
              <button
                onClick={handleCleanOrphans}
                className="mt-2 w-full px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-heading font-bold hover:bg-red-700 transition-colors"
              >
                Auto-fix: Remove orphaned trips and stop times
              </button>
            )}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="bg-gold-light border border-gold rounded-lg p-3 mb-4">
            <button
              type="button"
              onClick={() => setWarningsExpanded((v) => !v)}
              aria-expanded={warningsExpanded}
              className="w-full flex items-center gap-2 text-left cursor-pointer hover:opacity-80 transition-opacity"
            >
              <span className="font-semibold text-sm text-amber-800 flex-1">
                {warnings.length} warning{warnings.length !== 1 ? 's' : ''} — export will proceed
              </span>
              <span className="text-amber-700 text-xs shrink-0">{warningsExpanded ? '▾' : '▸'}</span>
            </button>
            {warningsExpanded && (
              <div className="mt-1">
                {warnings.slice(0, 8).map((w) => (
                  <p key={w.id} className="text-xs text-amber-700">• {w.message}</p>
                ))}
                {warnings.length > 8 && (
                  <p className="text-xs text-amber-600 mt-1">...and {warnings.length - 8} more</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* File summary */}
        {(() => {
          const exportableFlex = state.flexZones.filter((z) => z.pickupWindowStart && z.pickupWindowEnd);
          const skippedFlex = state.flexZones.filter((z) => !(z.pickupWindowStart && z.pickupWindowEnd));
          // Match the exporter's filters: locations.geojson is written for any
          // zone with polygon geometry (incl. mixed zones); location_groups.txt
          // for any zone with a non-empty stop group (incl. mixed zones).
          const polygonZones = state.flexZones.filter((z) => flexZoneHasPolygons(z));
          const groupZones = state.flexZones.filter((z) => flexZoneHasGroup(z) && (z.stopIds?.length ?? 0) > 0);
          const hasFlexBooking = state.flexZones.some((z) => z.bookingRule);
          const hasDirections = state.routes.some(
            (r) => r._direction_0_name || r._direction_1_name,
          );
          const files: [string, boolean, string?][] = [
            ['agency.txt', state.agencies.length > 0, `${state.agencies.length} agenc${state.agencies.length !== 1 ? 'ies' : 'y'}`],
            ['routes.txt', state.routes.length > 0, `${state.routes.length} routes`],
            ['stops.txt', state.stops.length > 0, `${state.stops.length} stops`],
            ['trips.txt', state.trips.length > 0 || exportableFlex.length > 0, `${state.trips.length + exportableFlex.length} trips`],
            ['stop_times.txt', state.stopTimes.length > 0 || exportableFlex.length > 0],
            ['calendar.txt', state.calendars.length > 0, `${state.calendars.length} service${state.calendars.length !== 1 ? 's' : ''}`],
            ['shapes.txt', state.shapes.length > 0, `${state.shapes.length} shape${state.shapes.length !== 1 ? 's' : ''}`],
            ['calendar_dates.txt', state.calendarDates.length > 0],
            ['directions.txt', hasDirections],
            ['fare_attributes.txt', state.fareAttributes.length > 0, `${state.fareAttributes.length} fare${state.fareAttributes.length !== 1 ? 's' : ''}`],
            ['fare_rules.txt', state.fareRules.length > 0],
            ['feed_info.txt', !!state.feedInfo],
            ['locations.geojson', polygonZones.length > 0, `${polygonZones.length} polygon zone${polygonZones.length !== 1 ? 's' : ''}`],
            ['location_groups.txt', groupZones.length > 0, `${groupZones.length} stop group${groupZones.length !== 1 ? 's' : ''}`],
            ['location_group_stops.txt', groupZones.length > 0],
            ['booking_rules.txt', hasFlexBooking],
          ];
          return (
            <>
              <div className="flex flex-col gap-1 mb-2 text-sm">
                {files.filter(([, hasData]) => hasData).map(([name, , detail]) => (
                  <div key={name} className="flex items-center gap-2 px-3 py-1.5 bg-cream rounded">
                    <span className="text-teal">✓</span>
                    <span>{name}</span>
                    {detail && <span className="ml-auto text-warm-gray text-xs">{detail}</span>}
                  </div>
                ))}
              </div>
              {skippedFlex.length > 0 && (
                <div className="bg-gold-light border border-gold rounded-lg p-3 mb-4 text-sm">
                  <p className="font-semibold text-amber-800 mb-1">
                    {skippedFlex.length} flex zone{skippedFlex.length !== 1 ? 's' : ''} will be skipped
                  </p>
                  <p className="text-xs text-amber-700 mb-1">
                    These have no pickup window set, so they can't produce a stop_times row. Open each zone's Details panel to add a start + end time.
                  </p>
                  <ul className="text-xs text-amber-700 list-disc pl-5">
                    {skippedFlex.slice(0, 5).map((z) => (<li key={z.id}>{z.name}</li>))}
                    {skippedFlex.length > 5 && <li>…and {skippedFlex.length - 5} more</li>}
                  </ul>
                </div>
              )}
            </>
          );
        })()}
        </div>

        <div className="px-6 py-4 border-t border-sand shrink-0 flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={hasErrors || exporting}
              className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm
                hover:bg-[#d4603a] transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {exporting ? 'Exporting...' : 'Export GTFS'}
            </button>
          </div>
          {/* Subtle secondary export — routes + stops as a GeoJSON FeatureCollection
              for GIS (free on every plan). Geometry-only, so it's allowed even with
              validation errors. Kept understated below the primary actions. */}
          <button
            onClick={handleExportGeoJSON}
            disabled={exporting || !hasGeoGeometry}
            title="Export route shapes (LineStrings) and stops (Points) as a GeoJSON FeatureCollection for QGIS, ArcGIS, Mapbox, etc."
            className="self-center inline-flex items-center gap-1.5 text-xs text-warm-gray hover:text-coral
              transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-warm-gray"
          >
            <span className="underline decoration-dotted underline-offset-2">Export routes &amp; stops as GeoJSON</span>
            {!canGeoExport && (
              <span className="text-[10px] font-semibold uppercase tracking-wide">🔒 {geoTargetPlan}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
