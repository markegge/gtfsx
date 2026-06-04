import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { runValidation } from '../../services/validation';
import {
  validateWithMobilityData,
  type CanonicalReport,
  type CanonicalNotice,
  type ValidatorProgress,
} from '../../services/validatorApi';
import { backendEnabled } from '../../utils/featureFlags';
import { Badge } from '../ui/Badge';

type Severity = 'ERROR' | 'WARNING' | 'INFO';

function severityVariant(sev: string): 'error' | 'warning' | 'info' {
  const s = sev.toUpperCase();
  if (s === 'ERROR') return 'error';
  if (s === 'WARNING') return 'warning';
  return 'info';
}

function progressLabel(p: ValidatorProgress): string {
  switch (p.phase) {
    case 'exporting':
      return 'Exporting feed…';
    case 'starting':
      return 'Starting validation job…';
    case 'uploading':
      return p.uploadFraction != null
        ? `Uploading feed… ${Math.round(p.uploadFraction * 100)}%`
        : 'Uploading feed…';
    case 'processing':
      return 'MobilityData is validating… this can take a few moments.';
    case 'done':
      return 'Done.';
  }
}

// Turn a sample notice object (arbitrary fields like filename/csvRowNumber/
// fieldName) into a compact, readable one-liner.
function describeSample(sample: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sample)) {
    if (v == null || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(', ');
}

function CanonicalResults({ report }: { report: CanonicalReport }) {
  const bySeverity = useMemo(() => {
    const groups: Record<Severity, CanonicalNotice[]> = { ERROR: [], WARNING: [], INFO: [] };
    for (const n of report.notices) {
      const sev = n.severity.toUpperCase();
      if (sev === 'ERROR') groups.ERROR.push(n);
      else if (sev === 'WARNING') groups.WARNING.push(n);
      else groups.INFO.push(n);
    }
    return groups;
  }, [report]);

  const order: Severity[] = ['ERROR', 'WARNING', 'INFO'];
  const totalErrors = bySeverity.ERROR.reduce((s, n) => s + n.totalNotices, 0);
  const totalWarnings = bySeverity.WARNING.reduce((s, n) => s + n.totalNotices, 0);
  const totalInfos = bySeverity.INFO.reduce((s, n) => s + n.totalNotices, 0);

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {totalErrors > 0 && <Badge variant="error">{totalErrors} Errors</Badge>}
        {totalWarnings > 0 && <Badge variant="warning">{totalWarnings} Warnings</Badge>}
        {totalInfos > 0 && <Badge variant="info">{totalInfos} Info</Badge>}
        {report.notices.length === 0 && <Badge variant="success">No issues</Badge>}
      </div>
      {report.validatorVersion && (
        <p className="text-[11px] text-warm-gray px-3 pb-1">
          Canonical validator v{report.validatorVersion}
          {report.validatedAt ? ` · ${new Date(report.validatedAt).toLocaleString()}` : ''}
        </p>
      )}
      {report.notices.length === 0 ? (
        <p className="text-sm text-warm-gray px-3 py-2">
          The MobilityData validator found no issues. Nice feed!
        </p>
      ) : (
        <div className="flex flex-col">
          {order.flatMap((sev) =>
            bySeverity[sev].map((n) => (
              <details key={`${sev}-${n.code}`} className="border-b border-[#F5F0EB]">
                <summary className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-cream list-none">
                  <Badge variant={severityVariant(sev)}>
                    {sev === 'ERROR' ? 'Error' : sev === 'WARNING' ? 'Warn' : 'Info'}
                  </Badge>
                  <span className="text-[13px] text-dark-brown break-all">
                    <span className="font-mono">{n.code}</span>
                    <span className="text-warm-gray"> · {n.totalNotices}</span>
                  </span>
                </summary>
                {n.sampleNotices.length > 0 && (
                  <div className="px-3 pb-2 pl-12">
                    <p className="text-[11px] text-warm-gray mb-1">
                      {n.totalNotices > n.sampleNotices.length
                        ? `${n.sampleNotices.length} of ${n.totalNotices} examples:`
                        : 'Examples:'}
                    </p>
                    <ul className="text-[11px] text-warm-gray font-mono space-y-0.5">
                      {n.sampleNotices.map((s, i) => (
                        <li key={i} className="break-all">
                          {describeSample(s) || '(no fields)'}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </details>
            )),
          )}
        </div>
      )}
    </div>
  );
}

// Small banner comparing our in-app counts to the canonical counts, so the user
// can see at a glance where the two validators agree or diverge.
function ComparisonBanner({
  inAppErrors,
  inAppWarnings,
  report,
}: {
  inAppErrors: number;
  inAppWarnings: number;
  report: CanonicalReport;
}) {
  const canonErrors = report.notices
    .filter((n) => n.severity.toUpperCase() === 'ERROR')
    .reduce((s, n) => s + n.totalNotices, 0);
  const canonWarnings = report.notices
    .filter((n) => n.severity.toUpperCase() === 'WARNING')
    .reduce((s, n) => s + n.totalNotices, 0);

  return (
    <div className="mx-2 mt-2 rounded bg-cream border border-[#EDE6DD] px-3 py-2">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-warm-gray text-left">
            <th className="font-semibold pb-1"> </th>
            <th className="font-semibold pb-1">In-app</th>
            <th className="font-semibold pb-1">MobilityData</th>
          </tr>
        </thead>
        <tbody className="text-dark-brown">
          <tr>
            <td className="pr-2">Errors</td>
            <td>{inAppErrors}</td>
            <td>{canonErrors}</td>
          </tr>
          <tr>
            <td className="pr-2">Warnings</td>
            <td>{inAppWarnings}</td>
            <td>{canonWarnings}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-[10px] text-warm-gray mt-1.5 leading-snug">
        Counts differ because the two validators check different rule sets. The MobilityData list below
        is the canonical reference.
      </p>
    </div>
  );
}

export function ValidationPanel() {
  const state = useStore();
  // Depend on the specific entity slices the validator reads; `state` as a
  // whole would re-trigger on every unrelated store change (UI state,
  // selection, etc.). Listing the slices is intentional — but it MUST cover
  // everything runValidation() reads, or warnings go stale (e.g. adding a fare
  // wouldn't clear "No fare information defined"). Keep this in sync with the
  // `state.*` reads in services/validation.ts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => runValidation(state), [
    state.agencies, state.calendars, state.calendarDates,
    state.routes, state.stops, state.trips, state.stopTimes, state.shapes,
    state.fareAttributes, state.fareRules, state.transfers,
    state.flexZones, state.frequencies, state.levels, state.pathways,
    state.featureSettings,
  ]);

  const errors = messages.filter((m) => m.severity === 'error');
  const warnings = messages.filter((m) => m.severity === 'warning');

  // ─── Canonical (MobilityData) validation state ──────────────────────────
  const [canonProgress, setCanonProgress] = useState<ValidatorProgress | null>(null);
  const [canonReport, setCanonReport] = useState<CanonicalReport | null>(null);
  const [canonError, setCanonError] = useState<string | null>(null);
  const running = canonProgress != null && canonProgress.phase !== 'done';

  const runCanonical = async () => {
    setCanonError(null);
    setCanonReport(null);
    setCanonProgress({ phase: 'exporting' });
    try {
      const report = await validateWithMobilityData((p) => setCanonProgress(p));
      setCanonReport(report);
    } catch (e) {
      setCanonError((e as Error)?.message ?? 'Validation failed. Please try again.');
    } finally {
      setCanonProgress(null);
    }
  };

  const handleClick = (m: typeof messages[0]) => {
    if (m.entity_type === 'agency') state.setSidebarSection('agency');
    else if (m.entity_type === 'calendar') state.setSidebarSection('calendar');
    else if (m.entity_type === 'fare' || m.entity_type === 'fare_rule') state.setSidebarSection('fares');
    else if (m.entity_type === 'flex_zone') state.setSidebarSection('flex');
    else if (m.entity_type === 'route') {
      state.setSidebarSection('routes');
      if (m.entity_id) state.selectRoute(m.entity_id);
    }
    else if (m.entity_type === 'stop') {
      state.setSidebarSection('stops');
      if (m.entity_id) state.selectStop(m.entity_id);
    }
    else if (m.entity_type === 'trip' || m.entity_type === 'stop_time') {
      // Timetable lives in the bottom panel now; the right rail no longer
      // hosts it. Surface the bottom panel on the timetable tab and pre-select
      // the route AND the trip's service + direction (+ shape pattern) so the
      // grid opens on exactly the cell the issue is about, not just the route.
      state.setBottomPanelOpen(true);
      state.setBottomPanelTab('timetable');
      if (m.entity_id) {
        const trip = state.trips.find((t) => t.trip_id === m.entity_id);
        if (trip) {
          state.selectRoute(trip.route_id);
          state.setTimetableServiceId(trip.service_id);
          state.setTimetableDirectionId(trip.direction_id);
          if (trip.shape_id) state.setTimetableShapeId(trip.shape_id);
        }
      }
    }
  };

  return (
    <div className="p-2 h-full overflow-y-auto min-h-0">
      <div className="flex items-center gap-2 px-2 mb-2 sticky top-0 bg-white py-1 z-10">
        <span className="font-heading font-bold text-sm">Validation</span>
        {errors.length > 0 && <Badge variant="error">{errors.length} Errors</Badge>}
        {warnings.length > 0 && <Badge variant="warning">{warnings.length} Warnings</Badge>}
        {messages.length === 0 && <Badge variant="success">All good</Badge>}
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-warm-gray px-2">No issues found. Your feed looks good!</p>
      ) : (
        <div className="flex flex-col">
          {messages.map((m) => (
            <button
              key={m.id}
              onClick={() => handleClick(m)}
              className="flex items-start gap-3 px-3 py-2.5 hover:bg-cream transition-colors text-left border-b border-[#F5F0EB]"
            >
              <Badge variant={m.severity === 'error' ? 'error' : 'warning'}>
                {m.severity === 'error' ? 'Error' : 'Warn'}
              </Badge>
              <div>
                <p className="text-[13px] text-dark-brown">{m.message}</p>
                {m.entity_type && (
                  <p className="text-[11px] text-warm-gray mt-0.5">
                    {m.entity_type} {m.entity_id ? `→ ${m.entity_id}` : ''} · Click to view
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ─── Canonical MobilityData validation ───────────────────────────── */}
      {backendEnabled && (
        <div className="mt-4 border-t border-[#EDE6DD] pt-3">
          <div className="px-2">
            <p className="font-heading font-bold text-[13px] mb-1">Canonical validator</p>
            <p className="text-[11px] text-warm-gray mb-2">
              Cross-check your feed against the official{' '}
              <span className="font-semibold">MobilityData GTFS validator</span> — the same engine that
              powers gtfs.org. Your feed is exported and sent to their hosted service.
            </p>
            <button
              onClick={runCanonical}
              disabled={running}
              className="w-full text-[13px] font-semibold rounded px-3 py-2 bg-purple text-white hover:bg-purple/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {running ? 'Validating…' : 'Validate with MobilityData (canonical)'}
            </button>
          </div>

          {canonProgress && running && (
            <p className="text-[12px] text-purple px-3 py-2 animate-pulse">
              {progressLabel(canonProgress)}
            </p>
          )}

          {canonError && (
            <div className="mx-2 mt-2 rounded bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-[12px] text-red-700">{canonError}</p>
            </div>
          )}

          {canonReport && !running && (
            <>
              <ComparisonBanner
                inAppErrors={errors.length}
                inAppWarnings={warnings.length}
                report={canonReport}
              />
              <CanonicalResults report={canonReport} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
