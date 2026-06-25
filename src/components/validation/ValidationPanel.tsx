import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { runValidation, DISMISSIBLE_RULE_LABELS } from '../../services/validation';
import {
  getValidationFix, applyValidationFix, applyValidationFixWithValue,
  type ValidationFix, type ValidationFixResult,
} from '../../services/validationFixes';
import { Badge } from '../ui/Badge';

/** Sensible initial pick for a guided fix's value picker — prefer "Accessible"
 *  (value 1, matching Stop Analysis's default) when offered, else the first
 *  option. Only seeds the dropdown; it never auto-applies. */
function defaultFixValue(fix: ValidationFix): number {
  const opts = fix.options ?? [];
  return opts.find((o) => o.value === 1)?.value ?? opts[0]?.value ?? 0;
}

export function ValidationPanel() {
  const state = useStore();
  const [showDismissed, setShowDismissed] = useState(false);
  // Last applied one-click fix, held for the undo toast. Lives outside the
  // validation memo so it survives the re-validate that clears the fixed error.
  const [fixUndo, setFixUndo] = useState<ValidationFixResult | null>(null);
  // Open guided-fix picker: the message id whose interactive fix is being
  // configured, and the value chosen so far. A guided fix (e.g. the wheelchair
  // bulk-fill) needs a user-chosen value, so clicking Fix opens this inline
  // picker instead of applying immediately. null = no picker open.
  const [pickerMsgId, setPickerMsgId] = useState<string | null>(null);
  const [pickerValue, setPickerValue] = useState<number>(0);
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
    // GTFS-Fares v2 slices — the validator reads them, so list them here or v2
    // warnings go stale (e.g. adding a fare product wouldn't clear a
    // "non-existent fare product" leg-rule error).
    state.fareAreas, state.stopAreas, state.fareNetworks, state.routeNetworks,
    state.timeframes, state.riderCategories, state.fareMedia, state.fareProducts,
    state.fareLegRules, state.fareTransferRules,
  ]);

  // A message is dismissed when its rule `code` is in the per-feed dismissed
  // set. Dismissed messages drop out of the main list (and the error/warning
  // counts) but stay restorable from the drawer below. runValidation doesn't
  // read dismissedValidations, so this filtering lives outside the memo.
  const dismissedCodes = state.dismissedValidations;
  const isDismissed = (m: typeof messages[0]) => !!m.code && dismissedCodes.includes(m.code);
  const visible = messages.filter((m) => !isDismissed(m));
  const dismissed = messages.filter(isDismissed);

  const errors = visible.filter((m) => m.severity === 'error');
  const warnings = visible.filter((m) => m.severity === 'warning');

  // Group the currently-suppressed messages by rule code so the drawer shows one
  // restorable row per rule (with a count when a rule silenced several services).
  const dismissedCounts = new Map<string, number>();
  for (const m of dismissed) dismissedCounts.set(m.code!, (dismissedCounts.get(m.code!) ?? 0) + 1);

  const handleClick = (m: typeof messages[0]) => {
    if (m.entity_type === 'agency') state.setSidebarSection('agency');
    else if (m.entity_type === 'calendar') {
      // Calendar/service issues (missing dates, all-days-off, holiday-exception
      // nudge, …) carry the service_id as entity_id. Open the Calendars panel
      // AND select that service so its editor opens — mirrors the stop case.
      state.setSidebarSection('calendar');
      if (m.entity_id) state.setEditingCalendarServiceId(m.entity_id);
    }
    else if (
      m.entity_type === 'fare' || m.entity_type === 'fare_rule' ||
      // GTFS-Fares v2 entity types all live in the Fares panel (v2 sub-tabs).
      m.entity_type === 'area' || m.entity_type === 'stop_area' ||
      m.entity_type === 'network' || m.entity_type === 'route_network' ||
      m.entity_type === 'timeframe' || m.entity_type === 'rider_category' ||
      m.entity_type === 'fare_media' || m.entity_type === 'fare_product' ||
      m.entity_type === 'fare_leg_rule' || m.entity_type === 'fare_transfer_rule'
    ) state.setSidebarSection('fares');
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
        {visible.length === 0 && <Badge variant="success">All good</Badge>}
      </div>

      {fixUndo && (
        <div className="flex items-center gap-2 bg-teal-light rounded-md px-2.5 py-1.5 mb-2 mx-2 text-[11px] text-dark-brown">
          <span className="flex-1">{fixUndo.label}</span>
          <button
            onClick={() => { fixUndo.undo(); setFixUndo(null); }}
            className="text-coral font-semibold hover:underline shrink-0"
          >
            Undo
          </button>
          <button
            onClick={() => setFixUndo(null)}
            className="text-warm-gray hover:text-dark-brown shrink-0"
            title="Dismiss"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-warm-gray px-2">
          {dismissed.length > 0
            ? 'No active issues. Dismissed reminders are listed below.'
            : 'No issues found. Your feed looks good!'}
        </p>
      ) : (
        <div className="flex flex-col">
          {visible.map((m) => {
            const fix = m.fix ? getValidationFix(m.fix.id) : undefined;
            const pickerOpen = !!fix?.interactive && pickerMsgId === m.id;
            return (
              <div key={m.id}>
                <div className="group flex items-stretch border-b border-[#F5F0EB] hover:bg-cream transition-colors">
                  <button
                    onClick={() => handleClick(m)}
                    className="flex items-start gap-3 px-3 py-2.5 text-left flex-1 min-w-0"
                  >
                    <Badge variant={m.severity === 'error' ? 'error' : 'warning'}>
                      {m.severity === 'error' ? 'Error' : 'Warn'}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-[13px] text-dark-brown">{m.message}</p>
                      {m.entity_type && (
                        <p className="text-[11px] text-warm-gray mt-0.5">
                          {m.entity_type} {m.entity_id ? `→ ${m.entity_id}` : ''} · Click to view
                        </p>
                      )}
                    </div>
                  </button>
                  {fix && (
                    <button
                      onClick={() => {
                        if (fix.interactive) {
                          // Guided fix: toggle the inline value picker, seeded
                          // with a sensible default (without auto-applying).
                          setPickerValue(defaultFixValue(fix));
                          setPickerMsgId((cur) => (cur === m.id ? null : m.id));
                        } else {
                          const result = applyValidationFix(m);
                          // Only surface the undo toast when the fix actually
                          // changed something (re-clicking a fixed message is a no-op).
                          if (result?.changed) setFixUndo(result);
                        }
                      }}
                      title={fix.description}
                      className="shrink-0 self-center mr-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors"
                    >
                      {fix.label}
                    </button>
                  )}
                  {m.code && (
                    <button
                      onClick={() => state.dismissValidation(m.code!)}
                      title="Dismiss this reminder for this feed"
                      aria-label="Dismiss this reminder for this feed"
                      className="shrink-0 px-2.5 text-warm-gray hover:text-dark-brown text-lg leading-none opacity-60 hover:opacity-100"
                    >
                      ×
                    </button>
                  )}
                </div>
                {pickerOpen && fix?.options && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-cream border-b border-[#F5F0EB]">
                    <span className="text-[11px] text-warm-gray shrink-0">Set value:</span>
                    <select
                      value={pickerValue}
                      onChange={(e) => setPickerValue(Number(e.target.value))}
                      aria-label="Value to apply"
                      className="flex-1 min-w-0 px-2 py-1 border border-sand rounded-md text-xs bg-white focus:outline-none focus:border-coral"
                    >
                      {fix.options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        const result = applyValidationFixWithValue(m, pickerValue);
                        if (result?.changed) setFixUndo(result);
                        setPickerMsgId(null);
                      }}
                      className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => setPickerMsgId(null)}
                      className="shrink-0 text-[11px] text-warm-gray hover:text-dark-brown"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dismissedCounts.size > 0 && (
        <div className="mt-2 border-t border-[#F5F0EB] pt-1.5">
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className="text-[12px] text-warm-gray hover:text-dark-brown px-2 py-1 flex items-center gap-1"
          >
            <span className="inline-block w-3">{showDismissed ? '▾' : '▸'}</span>
            {dismissed.length} dismissed
          </button>
          {showDismissed && (
            <div className="flex flex-col mt-0.5">
              {[...dismissedCounts.entries()].map(([code, count]) => (
                <div
                  key={code}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-warm-gray border-b border-[#F5F0EB]"
                >
                  <span className="line-through min-w-0 truncate">
                    {DISMISSIBLE_RULE_LABELS[code] ?? code}
                    {count > 1 ? ` (${count})` : ''}
                  </span>
                  <button
                    onClick={() => state.restoreValidation(code)}
                    className="shrink-0 text-coral hover:underline font-medium"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
