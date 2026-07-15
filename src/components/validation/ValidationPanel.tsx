import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { runValidation, DISMISSIBLE_RULE_LABELS } from '../../services/validation';
import {
  getValidationFix, applyValidationFix, applyValidationFixBatch,
  applyWheelchairFill, wheelchairGapCount,
  type ValidationFixResult,
} from '../../services/validationFixes';
import { groupValidationMessages } from '../../services/validationGrouping';
import { noShapeBucketId } from '../ui/shapePatterns';
import type { ValidationMessage } from '../../types/ui';
import { Badge } from '../ui/Badge';
import { ShapesFromStopsDialog } from '../shapes/ShapesFromStopsDialog';

// Below this many active messages the panel defaults to the flat "Individual"
// list; at or above it, it opens "By type" so a feed with hundreds of the same
// error isn't an unscrollable wall. The user can flip freely either way.
const GROUP_DEFAULT_THRESHOLD = 50;
// An expanded group reveals its rows in pages so opening an 832-strong group
// never mounts 832 DOM nodes at once.
const CHILD_PAGE = 50;

type ViewMode = 'individual' | 'grouped';
// Rail target: a whole group (batch), or one message within a group (single).
type Selection = { groupKey: string; messageId?: string } | null;

export function ValidationPanel() {
  const state = useStore();
  const [showDismissed, setShowDismissed] = useState(false);
  // null = follow the auto default (count-driven); a value = the user's explicit
  // choice, which sticks even as the count changes (e.g. after a batch fix).
  const [modeOverride, setModeOverride] = useState<ViewMode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [childLimits, setChildLimits] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Selection>(null);
  // Last applied fix (single OR batch), held for the undo toast. Lives outside
  // the validation memo so it survives the re-validate that clears fixed errors.
  const [fixUndo, setFixUndo] = useState<ValidationFixResult | null>(null);
  // An `interactive` fix (currently just generate-shapes-from-stops) has no
  // `apply` to run — clicking its Fix button opens this dialog instead.
  const [showShapesDialog, setShowShapesDialog] = useState(false);

  // Depend on the specific entity slices the validator reads; `state` as a
  // whole would re-trigger on every unrelated store change (UI state,
  // selection, etc.). Listing the slices is intentional — but it MUST cover
  // everything runValidation() reads, or warnings go stale (e.g. adding a fare
  // wouldn't clear "No fare information defined"). Keep this in sync with the
  // `state.*` reads in services/validation.ts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => runValidation(state), [
    state.agencies, state.calendars, state.calendarDates,
    state.routes, state.routeStops, state.stops, state.trips, state.stopTimes, state.shapes,
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
  const visible = useMemo(
    () => messages.filter((m) => !(m.code && dismissedCodes.includes(m.code))),
    [messages, dismissedCodes],
  );
  const dismissed = useMemo(
    () => messages.filter((m) => !!m.code && dismissedCodes.includes(m.code)),
    [messages, dismissedCodes],
  );

  const groups = useMemo(() => groupValidationMessages(visible), [visible]);

  const errorCount = useMemo(() => visible.filter((m) => m.severity === 'error').length, [visible]);
  const warningCount = useMemo(() => visible.filter((m) => m.severity === 'warning').length, [visible]);

  const mode: ViewMode = modeOverride
    ?? (visible.length >= GROUP_DEFAULT_THRESHOLD ? 'grouped' : 'individual');

  // Drop a rail selection whose group has been resolved away (e.g. a batch fix
  // emptied it), so the rail doesn't dangle on a stale target.
  useEffect(() => {
    if (selected && !groups.some((g) => g.key === selected.groupKey)) setSelected(null);
  }, [groups, selected]);

  // Group the currently-suppressed messages by rule code so the drawer shows one
  // restorable row per rule (with a count when a rule silenced several services).
  const dismissedCounts = new Map<string, number>();
  for (const m of dismissed) dismissedCounts.set(m.code!, (dismissedCounts.get(m.code!) ?? 0) + 1);

  const handleClick = (m: ValidationMessage) => {
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
          // A shaped trip opens on its shape; a shapeless "ghost" trip opens on
          // the synthetic "No shape" bucket so the grid actually shows it.
          state.setTimetableShapeId(trip.shape_id || noShapeBucketId(trip.direction_id));
        }
      }
    }
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const applySingle = (m: ValidationMessage) => {
    const result = applyValidationFix(m);
    // Only surface the undo toast when the fix actually changed something
    // (re-clicking an already-fixed message is a no-op).
    if (result?.changed) setFixUndo(result);
  };

  const applyBatch = (msgs: ValidationMessage[]) => {
    const result = applyValidationFixBatch(msgs);
    // Always toast a batch (it reports "X of N", incl. "all already fine"), but
    // only keep an undo handle when something actually changed.
    if (result) setFixUndo(result.changed ? result : null);
  };

  // The wheelchair fix carries a value choice (0/1/2), so the rail renders a
  // picker that calls this instead of the generic one-click apply.
  const applyWheelchair = (value: number) => {
    const result = applyWheelchairFill(value);
    if (result.changed) setFixUndo(result);
  };

  // The rail's current group + (optional) focused message, resolved from `selected`.
  const selectedGroup = selected ? groups.find((g) => g.key === selected.groupKey) ?? null : null;
  const focusedMessage = selected?.messageId
    ? selectedGroup?.messages.find((m) => m.id === selected.messageId) ?? null
    : null;

  // ---- a single message row (shared by Individual mode + expanded groups) ----
  const renderRow = (m: ValidationMessage, indent: boolean) => {
    const isSelected = selected?.messageId === m.id;
    return (
      <div
        key={m.id}
        className={`group flex items-stretch border-b border-[#F5F0EB] transition-colors
          ${isSelected ? 'bg-coral-light' : 'hover:bg-cream'}`}
      >
        <button
          onClick={() => { handleClick(m); selectMessage(m); }}
          className={`flex items-start gap-3 px-3 py-2.5 text-left flex-1 min-w-0 ${indent ? 'pl-7' : ''}`}
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
        {m.fix && m.fix.id !== 'fill-missing-wheelchair' && getValidationFix(m.fix.id) && (
          <button
            onClick={() => {
              // Interactive fixes (no `apply`) have no one-click mutation to
              // run — open their dialog instead. Mirrors the wheelchair
              // special-case above, generalized via the `interactive` flag.
              const fixDef = getValidationFix(m.fix!.id)!;
              if (fixDef.interactive) setShowShapesDialog(true);
              else applySingle(m);
            }}
            title={getValidationFix(m.fix.id)!.description}
            className="shrink-0 self-center mr-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors"
          >
            {getValidationFix(m.fix.id)!.label}
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
    );
  };

  // Selecting a message resolves its group key so the rail can offer "Fix all of
  // this type" alongside "Fix this one". Computed from the live groups.
  function selectMessage(m: ValidationMessage) {
    const g = groups.find((grp) => grp.messages.some((x) => x.id === m.id));
    setSelected({ groupKey: g?.key ?? '', messageId: m.id });
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header — title, count badges, and the Individual / By type toggle. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-sand bg-white shrink-0 flex-wrap">
        <span className="font-heading font-bold text-sm">Validation</span>
        {errorCount > 0 && <Badge variant="error">{errorCount} Errors</Badge>}
        {warningCount > 0 && <Badge variant="warning">{warningCount} Warnings</Badge>}
        {visible.length === 0 && <Badge variant="success">All good</Badge>}
        {visible.length > 0 && (
          <div className="ml-auto inline-flex rounded-md border border-sand overflow-hidden text-[11px] font-semibold">
            {(['individual', 'grouped'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setModeOverride(m)}
                className={`px-2.5 py-1 transition-colors ${mode === m
                  ? 'bg-coral-light text-coral'
                  : 'text-warm-gray hover:text-dark-brown'}`}
                aria-pressed={mode === m}
              >
                {m === 'individual' ? 'Individual' : 'By type'}
              </button>
            ))}
          </div>
        )}
      </div>

      {fixUndo && (
        <div className="flex items-center gap-2 bg-teal-light rounded-md px-2.5 py-1.5 mt-2 mx-2 text-[11px] text-dark-brown shrink-0">
          <span className="flex-1">{fixUndo.label}</span>
          {fixUndo.changed && (
            <button
              onClick={() => { fixUndo.undo(); setFixUndo(null); }}
              className="text-coral font-semibold hover:underline shrink-0"
            >
              Undo
            </button>
          )}
          <button
            onClick={() => setFixUndo(null)}
            className="text-warm-gray hover:text-dark-brown shrink-0"
            title="Dismiss"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Body — list column + right-rail fix recipe. Stacks on narrow widths. */}
      <div className="flex-1 min-h-0 flex flex-col min-[700px]:flex-row">
        {/* List column */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="text-sm text-warm-gray px-2">
              {dismissed.length > 0
                ? 'No active issues. Dismissed reminders are listed below.'
                : 'No issues found. Your feed looks good!'}
            </p>
          ) : mode === 'individual' ? (
            <div className="flex flex-col">
              {visible.map((m) => renderRow(m, false))}
            </div>
          ) : (
            <div className="flex flex-col">
              {groups.map((g) => {
                const isOpen = expanded.has(g.key);
                const isSelected = selected?.groupKey === g.key && !selected.messageId;
                const limit = childLimits[g.key] ?? CHILD_PAGE;
                const shown = isOpen ? g.messages.slice(0, limit) : [];
                return (
                  <div key={g.key} className="border-b border-[#F5F0EB]">
                    <div
                      className={`group flex items-stretch transition-colors
                        ${isSelected ? 'bg-coral-light' : 'hover:bg-cream'}`}
                    >
                      <button
                        onClick={() => toggleExpanded(g.key)}
                        className="shrink-0 self-stretch px-2 text-warm-gray hover:text-dark-brown"
                        title={isOpen ? 'Collapse' : 'Expand'}
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                        aria-expanded={isOpen}
                      >
                        <span className="inline-block w-3 text-[11px]">{isOpen ? '▾' : '▸'}</span>
                      </button>
                      <button
                        onClick={() => setSelected({ groupKey: g.key })}
                        className="flex items-start gap-3 py-2.5 pr-2 text-left flex-1 min-w-0"
                      >
                        <Badge variant={g.severity === 'error' ? 'error' : 'warning'}>
                          {g.severity === 'error' ? 'Error' : 'Warn'}
                        </Badge>
                        <div className="min-w-0">
                          <p className="text-[13px] text-dark-brown">
                            <span className="font-semibold">{g.count}×</span> {g.summary}
                          </p>
                          <p className="text-[11px] text-warm-gray mt-0.5">
                            {g.fixableCount > 0
                              ? `${g.fixableCount} of ${g.count} auto-fixable · Click for the fix recipe`
                              : 'Click to expand · no automatic fix'}
                          </p>
                        </div>
                      </button>
                      {g.code && (
                        <button
                          onClick={() => state.dismissValidation(g.code!)}
                          title="Dismiss this reminder for this feed"
                          aria-label="Dismiss this reminder for this feed"
                          className="shrink-0 px-2.5 text-warm-gray hover:text-dark-brown text-lg leading-none opacity-60 hover:opacity-100"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {isOpen && (
                      <div className="flex flex-col bg-cream/40">
                        {shown.map((m) => renderRow(m, true))}
                        {g.messages.length > shown.length && (
                          <button
                            onClick={() => setChildLimits((p) => ({ ...p, [g.key]: limit + CHILD_PAGE }))}
                            className="text-[12px] text-coral hover:underline font-medium px-7 py-1.5 text-left"
                          >
                            Show {Math.min(CHILD_PAGE, g.messages.length - shown.length)} more
                            {` (${shown.length} of ${g.messages.length})`}
                          </button>
                        )}
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

        {/* Right-rail fix recipe */}
        <div className="shrink-0 min-[700px]:w-72 border-t min-[700px]:border-t-0 min-[700px]:border-l border-sand bg-cream/30 overflow-y-auto">
          <FixRecipeRail
            group={selectedGroup}
            focused={focusedMessage}
            onFixOne={() => focusedMessage && applySingle(focusedMessage)}
            onFixAll={() => selectedGroup && applyBatch(selectedGroup.messages)}
            onWheelchairFill={applyWheelchair}
            onOpenInteractiveFix={() => setShowShapesDialog(true)}
          />
        </div>
      </div>

      {showShapesDialog && (
        <ShapesFromStopsDialog onClose={() => setShowShapesDialog(false)} />
      )}
    </div>
  );
}

// The right-rail "how do I fix this" panel. Shows the catalog recipe for the
// selected rule's fix (or a no-auto-fix note) plus Fix-this-one / Fix-all-N.
function FixRecipeRail({
  group, focused, onFixOne, onFixAll, onWheelchairFill, onOpenInteractiveFix,
}: {
  group: ReturnType<typeof groupValidationMessages>[number] | null;
  focused: ValidationMessage | null;
  onFixOne: () => void;
  onFixAll: () => void;
  onWheelchairFill: (value: number) => void;
  /** Open the dialog for an `interactive` fix (currently just
   *  generate-shapes-from-stops — see services/validationFixes.ts). */
  onOpenInteractiveFix: () => void;
}) {
  if (!group) {
    return (
      <div className="p-3 text-[12px] text-warm-gray">
        <p className="font-heading font-bold text-[13px] text-dark-brown mb-1">Fix recipe</p>
        <p>Select an issue to see how to fix it.</p>
      </div>
    );
  }
  const fix = group.fixId ? getValidationFix(group.fixId) : undefined;
  const focusedFixDef = focused?.fix ? getValidationFix(focused.fix.id) : undefined;
  // Interactive fixes are never one-click-fixable, at the single-message
  // level either — "Fix this one" stays disabled for them (the button itself
  // doesn't even render once `fix.interactive` is true; see below).
  const focusedFixable = !!(focusedFixDef && !focusedFixDef.interactive);
  return (
    <div className="p-3 flex flex-col gap-2.5">
      <p className="font-heading font-bold text-[13px] text-dark-brown">Fix recipe</p>

      <div className="flex items-center gap-2">
        <Badge variant={group.severity === 'error' ? 'error' : 'warning'}>
          {group.severity === 'error' ? 'Error' : 'Warn'}
        </Badge>
        <span className="text-[11px] text-warm-gray">{group.count} affected</span>
      </div>

      <p className="text-[12px] text-dark-brown leading-snug">
        {focused ? focused.message : group.summary}
      </p>

      <div className="rounded-md bg-white border border-sand p-2.5">
        <p className="text-[10px] font-bold uppercase tracking-wide text-warm-gray mb-1">
          How to fix
        </p>
        <p className="text-[12px] text-dark-brown leading-snug">
          {fix
            ? fix.description
            : 'No automatic fix for this rule. Open an item to edit it directly in its panel.'}
        </p>
      </div>

      {fix && fix.interactive ? (
        // No one-click apply (and no batch "Fix all N" — this recipe needs a
        // mode choice + network calls, so every affected message is fixed
        // through the same dialog, one feed-wide run at a time).
        <button
          onClick={onOpenInteractiveFix}
          className="px-3 py-1.5 rounded-md text-[12px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors"
        >
          {fix.label}
        </button>
      ) : fix && group.fixId === 'fill-missing-wheelchair' ? (
        <WheelchairFillPicker onFill={onWheelchairFill} />
      ) : fix && (
        <div className="flex flex-col gap-1.5">
          {focused && (
            <button
              onClick={onFixOne}
              disabled={!focusedFixable}
              className="px-3 py-1.5 rounded-md text-[12px] font-semibold bg-white border border-teal text-teal hover:bg-teal-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Fix this one
            </button>
          )}
          {group.fixableCount > 0 && (
            <button
              onClick={onFixAll}
              className="px-3 py-1.5 rounded-md text-[12px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors"
            >
              Fix all {group.fixableCount} of this type
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Value picker for the wheelchair_boarding fix recipe. Mirrors the old Stop
// Analysis bulk-fill: pick the value to apply (1 = accessible / 2 = not / 0 = no
// info) and fill every board point missing a value. 1 or 2 clears the warning;
// 0 records "reviewed, no info" (the warning persists, since GTFS reads blank
// and 0 the same).
function WheelchairFillPicker({ onFill }: { onFill: (value: number) => void }) {
  const [value, setValue] = useState(1);
  const gapCount = wheelchairGapCount();
  const OPTIONS: { v: number; label: string }[] = [
    { v: 1, label: 'Accessible' },
    { v: 2, label: 'Not accessible' },
    { v: 0, label: 'No info' },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold text-warm-gray">Fill missing values with</p>
      <div className="flex gap-1">
        {OPTIONS.map((o) => (
          <button
            key={o.v}
            onClick={() => setValue(o.v)}
            className={`flex-1 px-1.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
              value === o.v
                ? 'border-teal bg-teal-light text-teal'
                : 'border-sand text-warm-gray hover:border-teal/50'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => onFill(value)}
        disabled={gapCount === 0}
        className="px-3 py-1.5 rounded-md text-[12px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {gapCount > 0 ? `Fill ${gapCount} missing` : 'Nothing to fill'}
      </button>
    </div>
  );
}
