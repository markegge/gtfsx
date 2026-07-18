import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { featureEnabled } from '../../store/featuresSlice';
import {
  formatTimeShort, gtfsTimeToSeconds, normalizeTimeInput, secondsToGtfsTime,
} from '../../utils/time';
import { directionName } from '../../utils/constants';
import type { Frequency, RouteStop, StopTime, Trip } from '../../types/gtfs';
import {
  generateTrips, validateGenerateParams, estimateRunSecs,
  type GenerateTripsParams, type GenerateValidation,
} from '../../services/timetableGen';
import { applyPatternRunTime, applyPatternEstimate, currentPatternRunSecs, type PatternRef } from '../../services/runtimes';
import { estimateStopTravelByRoad, layoutStopTimes } from '../../services/travelTime';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { AuthButton } from '../auth/AuthButton';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Toast, type ToastState } from '../ui/Toast';
import { type PaneScope, useTimetableData } from './useTimetableData';
import {
  planCascade, nextCompanionShapeId, generateExistingIds,
  clampSplitRatio, splitResizable, splitRatioFromPointer, SPLIT_MIN_PANE_PX, SPLIT_DEFAULT_RATIO,
  swapRouteDirections,
} from './timetableGridHelpers';
import { TimetableGridPane } from './TimetableGridPane';
import { SplitDivider } from './timetableGridParts';
import { TimetableToolbar, type ToolId } from './TimetableToolbar';
import { GenerateDrawer, RuntimeDrawer, RepeatDrawer, FrequencyDrawer, type GenerateInput } from './TimetableDrawers';
import { FlexTimetablePanel } from './FlexTimetablePanel';
import { findFlexZoneForRoute, isFlexRoute } from './flexRouteMatch';
import type { ShapePattern } from '../ui/shapePatterns';
import { mintTripId, tripIdPrefixForRoute } from '../../services/tripNaming';
import { windowDepartureCount, type FrequencyWindow } from '../../services/frequencyExpansion';

/** Feed arrays captured before a bulk op, for snapshot-based undo. Immer keeps
 *  replaced arrays immutable, so holding a reference is a valid point-in-time
 *  snapshot without cloning. */
/** Shared defaults for road-network time estimation — used by both the per-trip
 *  ◷ Estimate action and the Set run time drawer's Estimate mode. */
const ESTIMATE_DEFAULTS = { dwellSec: 18, speedFactor: 1.3 };

type Snap = { trips: Trip[]; stopTimes: StopTime[]; frequencies: Frequency[]; routeStops: RouteStop[] };
function snapshotFeed(): Snap {
  const st = useStore.getState();
  // routeStops rides along so the Swap-directions edit (which flips route_stops
  // too) reverts in one Undo. Other ops don't touch it, so restoring the same
  // reference is a no-op for them.
  return { trips: st.trips, stopTimes: st.stopTimes, frequencies: st.frequencies, routeStops: st.routeStops };
}

type PaneId = 'main' | 'opp';
type CommitField = 'both' | 'arrival_time' | 'departure_time';
type ModalState =
  | { type: 'duplicate'; paneId: PaneId; tripId: string }
  | { type: 'estimate'; paneId: PaneId; tripId: string }
  | { type: 'applyall'; paneId: PaneId; tripId: string }
  | { type: 'removeall' }
  | { type: 'generate-confirm'; input: GenerateInput; existingCount: number }
  | { type: 'swapdir' }
  | null;
type CascadeState = { paneId: PaneId; seq: number; stopId: string; stopName: string; deltaMin: number; laterIds: string[] } | null;

/**
 * Timetable panel orchestrator. Owns the main pane's selection (proxying the
 * global `timetable*` store fields), the optional derived companion pane
 * (opposite direction / another pattern), the bulk-tool drawer, the per-trip
 * modals, and the shared toast + cascade UI. Both panes are presentational
 * `TimetableGridPane`s; every mutation flows through the handlers here, so the
 * two panes stay live and edits are consistent. Replaces the old monolithic
 * grid + the separate SplitTimetable wrapper.
 */
export function TimetableGrid() {
  const store = useStore();
  const {
    routes, trips, stops, routeStops, calendars, shapes,
    setStopTime, addTrip, duplicateTrip, applyTripPattern, removeTrip, updateTrip,
    renameTripId, interpolateStopTimes, skipStop, seedTripStops,
  } = store;

  // Main-pane selection proxies the global timetable fields.
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const selectRoute = useStore((s) => s.selectRoute);
  const directionId = useStore((s) => s.timetableDirectionId);
  const setDirectionId = useStore((s) => s.setTimetableDirectionId);
  const selectedServiceId = useStore((s) => s.timetableServiceId);
  const setSelectedServiceId = useStore((s) => s.setTimetableServiceId);
  const selectedShapeId = useStore((s) => s.timetableShapeId);
  const setSelectedShapeId = useStore((s) => s.setTimetableShapeId);

  const oppositeOpen = useStore((s) => s.timetableOppositeOpen);
  const setOppositeOpen = useStore((s) => s.setTimetableOppositeOpen);
  const arrDepStops = useStore((s) => s.timetableArrDepStops);
  const setArrDep = useStore((s) => s.setTimetableArrDep);
  const rowActions = useStore((s) => s.timetableRowActions);
  const setRowActions = useStore((s) => s.setTimetableRowActions);
  const headwayHints = useStore((s) => s.timetableHeadwayHints);
  const setHeadwayHints = useStore((s) => s.setTimetableHeadwayHints);
  const requestFrequencyConversion = useStore((s) => s.requestFrequencyConversion);

  const showContinuous = useStore((s) => featureEnabled(s, 'continuousStops'));
  const demandResponseOn = useStore((s) => featureEnabled(s, 'demandResponse'));
  const flexZones = useStore((s) => s.flexZones);

  // frequencies.txt windows grouped by their template trip_id — drives the
  // read-only build-out rows in both panes (item #8). One map for the whole feed;
  // each pane only looks up the trip_ids it actually renders.
  const frequencies = useStore((s) => s.frequencies);
  const frequenciesByTrip = useMemo(() => {
    const m = new Map<string, FrequencyWindow[]>();
    for (const f of frequencies) {
      const w: FrequencyWindow = { start_time: f.start_time, end_time: f.end_time, headway_secs: f.headway_secs, exact_times: f.exact_times };
      const arr = m.get(f.trip_id);
      if (arr) arr.push(w); else m.set(f.trip_id, [w]);
    }
    return m;
  }, [frequencies]);

  /* ---------- pane data ---------- */
  const mainScope: PaneScope = { routeId: selectedRouteId, directionId, serviceId: selectedServiceId, shapeId: selectedShapeId };
  const mainData = useTimetableData(mainScope, true);
  const {
    route, patterns, activeServiceId, effectiveShapeId, noShapeBucket, orderedStops, routeTrips,
  } = mainData;

  // Companion scope — any pattern except the main pane's; defaults to the
  // opposite direction. `hasOpposite` gates rendering so a stale shape can't leak
  // the main direction into the companion.
  const oppDir: 0 | 1 = directionId === 0 ? 1 : 0;
  // The companion (right) pane's pattern. null = auto-derived (opposite of the
  // left); a shapeId = the user's explicit pick. A new route drops any choice; a
  // left-pattern change keeps an explicit right choice unless it now collides
  // with the left or is stale (item #7).
  const [companionShapeId, setCompanionShapeId] = useState<string | null>(null);
  useEffect(() => { setCompanionShapeId(null); }, [selectedRouteId]);
  useEffect(() => {
    setCompanionShapeId((prev) => nextCompanionShapeId(prev, effectiveShapeId, patterns.map((p) => p.shapeId)));
  }, [effectiveShapeId, patterns]);
  // Split is now toggled independently of direction selection (standalone Split
  // View button). Keep the state honest: a route with nothing to compare (<2
  // patterns) can't be split, so close it if it was left open.
  useEffect(() => {
    if (patterns.length < 2 && oppositeOpen) setOppositeOpen(false);
  }, [patterns.length, oppositeOpen, setOppositeOpen]);

  const companionPattern: ShapePattern | null = useMemo(() => {
    const chosen = companionShapeId && companionShapeId !== effectiveShapeId
      ? patterns.find((p) => p.shapeId === companionShapeId)
      : undefined;
    if (chosen) return chosen;
    return patterns.find((p) => p.directionId === oppDir && p.shapeId !== effectiveShapeId)
      ?? patterns.find((p) => p.shapeId !== effectiveShapeId)
      ?? null;
  }, [companionShapeId, effectiveShapeId, patterns, oppDir]);

  const companionDir: 0 | 1 = companionPattern ? companionPattern.directionId : oppDir;
  const companionScope: PaneScope = {
    routeId: selectedRouteId,
    directionId: companionDir,
    serviceId: selectedServiceId,
    shapeId: companionPattern ? companionPattern.shapeId : null,
  };
  const oppData = useTimetableData(companionScope, false);

  const hasOpposite = useMemo(() => {
    if (!selectedRouteId) return false;
    if (patterns.length === 0) {
      return trips.some((t) => t.route_id === selectedRouteId
        && (!activeServiceId || t.service_id === activeServiceId) && t.direction_id === oppDir);
    }
    return !!companionPattern && oppData.routeTrips.length > 0;
  }, [selectedRouteId, patterns.length, trips, activeServiceId, oppDir, companionPattern, oppData.routeTrips.length]);

  /* ---------- drawer / modal / toast / cascade state ---------- */
  const [drawer, setDrawer] = useState<'generate' | 'runtime' | 'repeat' | 'frequency' | null>(null);
  const [freqEditTripId, setFreqEditTripId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [cascade, setCascade] = useState<CascadeState>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cascadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const oppScrollRef = useRef<HTMLDivElement | null>(null);

  // Split-view divider: a persisted left-pane ratio, dragged imperatively (no
  // re-render per pointermove — set the left pane's flex-basis directly) and
  // committed to the store on drag-end.
  const splitRatio = useStore((s) => s.timetableSplitRatio);
  const setSplitRatio = useStore((s) => s.setTimetableSplitRatio);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const leftPaneRef = useRef<HTMLDivElement | null>(null);
  const dragRatioRef = useRef<number | null>(null);
  const [splitContainerW, setSplitContainerW] = useState(0);
  useEffect(() => {
    const el = splitContainerRef.current;
    if (!el) return;
    setSplitContainerW(el.clientWidth);
    const ro = new ResizeObserver((entries) => setSplitContainerW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const splitIsResizable = oppositeOpen && splitResizable(splitContainerW);
  const effectiveSplitRatio = splitIsResizable ? clampSplitRatio(splitRatio, splitContainerW) : SPLIT_DEFAULT_RATIO;
  const handleSplitDrag = useCallback((clientX: number) => {
    const box = splitContainerRef.current, left = leftPaneRef.current;
    if (!box || !left) return;
    const rect = box.getBoundingClientRect();
    const r = splitRatioFromPointer(clientX, rect.left, rect.width);
    dragRatioRef.current = r;
    left.style.flexBasis = `${r * 100}%`; // imperative during drag — smooth, no React churn
  }, []);
  const handleSplitDragEnd = useCallback(() => {
    if (dragRatioRef.current != null) setSplitRatio(dragRatioRef.current);
    dragRatioRef.current = null;
    window.dispatchEvent(new Event('resize')); // §8: grids re-measure sticky offsets + column math
  }, [setSplitRatio]);
  const handleSplitReset = useCallback(() => {
    dragRatioRef.current = null;
    setSplitRatio(SPLIT_DEFAULT_RATIO);
    window.dispatchEvent(new Event('resize'));
  }, [setSplitRatio]);

  const say = useCallback((message: string) => {
    setToast({ message });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Snapshot-based undo (HANDOFF §5). The app's history coalescing splits a
  // multi-entity bulk op into several undo steps, so a single global undo()
  // would only revert a sliver. Instead we snapshot the affected feed arrays
  // BEFORE the op and the Undo button restores them wholesale.
  const undoToast = useCallback((message: string, snap: Snap) => {
    setToast({
      message,
      onUndo: () => {
        const s = useStore.getState();
        s.setTrips(snap.trips);
        s.setStopTimes(snap.stopTimes);
        s.setFrequencies(snap.frequencies);
        s.setRouteStops(snap.routeStops);
        setToast({ message: 'Undone' });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 1800);
      },
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  }, []);
  // Snapshot, run the mutation, then show the Undo toast with the op's message.
  const withUndo = useCallback((run: () => string) => {
    const snap = snapshotFeed();
    undoToast(run(), snap);
  }, [undoToast]);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (cascadeTimer.current) clearTimeout(cascadeTimer.current);
  }, []);

  // Reset transient UI when the route changes / the selection key changes.
  useEffect(() => { setDrawer(null); setFreqEditTripId(null); setCascade(null); }, [selectedRouteId]);
  useEffect(() => { setCascade(null); }, [effectiveShapeId, activeServiceId, directionId]);
  // Relayout the map/grid when the split toggles (§8 synthetic resize).
  useEffect(() => { window.dispatchEvent(new Event('resize')); }, [oppositeOpen]);

  // Split view: keep both panes' vertical scroll aligned (toggleable).
  useEffect(() => {
    const a = mainScrollRef.current;
    const b = oppScrollRef.current;
    if (!oppositeOpen || !syncScroll || !a || !b) return;
    let lock = false;
    const mk = (src: HTMLDivElement, dst: HTMLDivElement) => () => {
      if (lock) return;
      lock = true;
      dst.scrollTop = src.scrollTop;
      requestAnimationFrame(() => { lock = false; });
    };
    const fa = mk(a, b);
    const fb = mk(b, a);
    a.addEventListener('scroll', fa);
    b.addEventListener('scroll', fb);
    return () => { a.removeEventListener('scroll', fa); b.removeEventListener('scroll', fb); };
  }, [oppositeOpen, syncScroll, hasOpposite, selectedRouteId, effectiveShapeId]);

  const paneData = (id: PaneId) => (id === 'opp' ? oppData : mainData);
  const paneScopeOf = (id: PaneId) => (id === 'opp' ? companionScope : mainScope);

  /* ---------- cell + row mutations ---------- */
  const onCell = useCallback((paneId: PaneId, tripId: string, seq: number, stopId: string, field: CommitField, normalized: string) => {
    const data = paneData(paneId);
    const st = data.findStopTime(tripId, seq);
    const prevTime = st?.arrival_time || st?.departure_time || '';
    const prevSec = prevTime ? gtfsTimeToSeconds(prevTime) : null;

    if (!normalized) {
      setStopTime(tripId, stopId, seq, { arrival_time: '', departure_time: '' });
    } else if (field === 'both') {
      setStopTime(tripId, stopId, seq, { arrival_time: normalized, departure_time: normalized });
    } else if (field === 'arrival_time') {
      setStopTime(tripId, stopId, seq, { arrival_time: normalized, departure_time: st?.departure_time || normalized });
    } else {
      setStopTime(tripId, stopId, seq, { arrival_time: st?.arrival_time || normalized, departure_time: normalized });
    }

    // Cascade offer: an edited (previously-set) time changed by Δ, and later
    // trips have a time in this column → offer to shift them too.
    if (normalized) {
      const plan = planCascade({
        orderedTripIds: data.routeTrips.map((t) => t.trip_id),
        editedTripId: tripId,
        prevSec,
        newSec: gtfsTimeToSeconds(normalized),
        hasTimeAt: (id) => { const s2 = data.findStopTime(id, seq); return !!(s2 && (s2.arrival_time || s2.departure_time)); },
      });
      if (plan) {
        const stopName = data.orderedStops.find((c) => c.seq === seq && c.stop.stop_id === stopId)?.stop.stop_name ?? '';
        setCascade({ paneId, seq, stopId, stopName, deltaMin: plan.deltaMin, laterIds: plan.laterIds });
        if (cascadeTimer.current) clearTimeout(cascadeTimer.current);
        cascadeTimer.current = setTimeout(() => setCascade(null), 9000);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainData, oppData, route, activeServiceId, calendars, setStopTime, renameTripId]);

  const applyCascade = () => {
    if (!cascade) return;
    const c = cascade;
    setCascade(null);
    withUndo(() => {
      const data = paneData(c.paneId);
      const shift = c.deltaMin * 60;
      for (const tid of c.laterIds) {
        const st = data.findStopTime(tid, c.seq);
        if (!st) continue;
        setStopTime(tid, st.stop_id, c.seq, {
          arrival_time: st.arrival_time ? secondsToGtfsTime(gtfsTimeToSeconds(st.arrival_time) + shift) : st.arrival_time,
          departure_time: st.departure_time ? secondsToGtfsTime(gtfsTimeToSeconds(st.departure_time) + shift) : st.departure_time,
        });
      }
      const n = c.laterIds.length;
      return `Shifted ${n} later trip${n === 1 ? '' : 's'} by ${c.deltaMin > 0 ? '+' : ''}${c.deltaMin} min`;
    });
  };

  const onRename = (tripId: string, newId: string) => {
    const trimmed = newId.trim();
    if (!trimmed || trimmed === tripId) return;
    if (trips.some((t) => t.trip_id === trimmed)) return; // keep ids unique
    renameTripId(tripId, trimmed);
  };

  const onRowAction = (paneId: PaneId, action: string, tripId: string) => {
    if (action === 'delete') withUndo(() => { removeTrip(tripId); return `Deleted ${tripId}`; });
    else if (action === 'interpolate') withUndo(() => { interpolateStopTimes(tripId); return `Interpolated blank times on ${tripId}`; });
    else if (action === 'duplicate') setModal({ type: 'duplicate', paneId, tripId });
    else if (action === 'estimate') setModal({ type: 'estimate', paneId, tripId });
    else if (action === 'applyall') setModal({ type: 'applyall', paneId, tripId });
    else if (action === 'editfreq') { setDrawer('frequency'); setFreqEditTripId(tripId); }
    else if (action === 'convert') requestFrequencyConversion([tripId]);
  };

  // Replace a frequency template's windows wholesale (the Edit frequency drawer).
  // Zero windows removes the frequency — the template becomes a plain trip. The
  // grid + visualization build-out re-derive live (both subscribe to
  // frequencies). One-step snapshot Undo.
  const applyFrequency = (tripId: string, windows: FrequencyWindow[]) => {
    setDrawer(null);
    setFreqEditTripId(null);
    withUndo(() => {
      const st = useStore.getState();
      const others = st.frequencies.filter((f) => f.trip_id !== tripId);
      const next = windows.map((w) => ({ trip_id: tripId, start_time: w.start_time, end_time: w.end_time, headway_secs: w.headway_secs, exact_times: w.exact_times }));
      st.setFrequencies([...others, ...next]);
      return windows.length === 0
        ? `Removed the frequency from ${tripId} — now a plain trip`
        : `Updated ${tripId}'s frequency (${windows.length} window${windows.length === 1 ? '' : 's'})`;
    });
  };

  const onAddTrip = (paneId: PaneId) => {
    const data = paneData(paneId);
    const scope = paneScopeOf(paneId);
    if (!scope.routeId) return;
    const tripId = mintTripId(tripIdPrefixForRoute(route), new Set(trips.map((t) => t.trip_id)));
    addTrip({
      trip_id: tripId,
      route_id: scope.routeId,
      service_id: data.activeServiceId || calendars[0]?.service_id || '',
      direction_id: scope.directionId,
      trip_headsign: route?.route_short_name || '',
      shape_id: data.noShapeBucket
        ? undefined
        : data.effectiveShapeId ?? trips.find((t) => t.route_id === scope.routeId && t.direction_id === scope.directionId)?.shape_id,
    });
    seedTripStops(tripId, data.orderedStops.map((c) => ({ stop_id: c.stop.stop_id, stop_sequence: c.seq })));
    say('Added a blank trip — first and last served stops need times');
  };

  const onTimepoint = (paneId: PaneId, stopId: string, seq: number, on: boolean) => {
    const data = paneData(paneId);
    for (const t of data.routeTrips) {
      if (data.findStopTime(t.trip_id, seq)) setStopTime(t.trip_id, stopId, seq, { timepoint: on ? 1 : 0 });
    }
    say(on ? 'Marked as key timepoint — published time' : 'Timepoint off — times interpolate through this stop');
  };

  const onArrDep = (stopId: string, on: boolean) => {
    setArrDep(stopId, on);
    say(on ? 'Column now takes separate arrival & departure times' : 'Back to one time per trip');
  };

  const onContinuous = (stopId: string, value: 'default' | 'none' | 'phone') => {
    if (!selectedRouteId) return;
    const enumVal: 0 | 1 | 2 | 3 | undefined = value === 'none' ? 1 : value === 'phone' ? 2 : undefined;
    const all = useStore.getState().stopTimes;
    for (const t of trips.filter((tr) => tr.route_id === selectedRouteId)) {
      const st = all.find((s) => s.trip_id === t.trip_id && s.stop_id === stopId);
      if (st) setStopTime(t.trip_id, stopId, st.stop_sequence, { continuous_pickup: enumVal, continuous_drop_off: enumVal });
    }
    say(value === 'default' ? 'Cleared pickup/drop-off override' : 'Continuous pickup override applied to all trips');
  };

  /* ---------- toolbar tools ---------- */
  const patternRouteStops = useCallback((dir: 0 | 1, shapeId: string | undefined): RouteStop[] => {
    if (!selectedRouteId) return [];
    return [...routeStops
      .filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === dir && (shapeId ? rs.shape_id === shapeId : true))]
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
  }, [selectedRouteId, routeStops]);

  const mainGenShapeId = noShapeBucket ? undefined : (effectiveShapeId ?? undefined);
  const mainPatternRouteStops = useMemo(() => patternRouteStops(directionId, mainGenShapeId), [patternRouteStops, directionId, mainGenShapeId]);
  const shape = mainGenShapeId ? shapes.find((s) => s.shape_id === mainGenShapeId) : undefined;

  const genPreview = useCallback((input: GenerateInput): GenerateValidation =>
    validateGenerateParams({ startTime: input.startTime, endTime: input.endTime, headwaySecs: input.headwaySecs, runSecs: input.runSecs, routeStops: mainPatternRouteStops }),
  [mainPatternRouteStops]);

  const endToEndDefault = useMemo(
    () => Math.max(1, Math.round(estimateRunSecs({ shape, routeStops: mainPatternRouteStops, stops }) / 60)),
    [shape, mainPatternRouteStops, stops],
  );
  const currentRunMin = useMemo(() => {
    const ref: PatternRef = { routeId: selectedRouteId || '', directionId, shapeId: mainGenShapeId };
    const secs = currentPatternRunSecs(ref);
    return secs ? Math.round(secs / 60) : 20;
  }, [selectedRouteId, directionId, mainGenShapeId]);

  // Generate lays out a fresh day of service, so when the pane already has trips
  // the usual intent is to REPLACE them, not stack a second set on top. Apply
  // therefore asks (Replace / Add / Cancel) whenever the scope is non-empty; an
  // empty scope generates straight through. A frequency template counts as an
  // existing trip, so re-generating over one prompts too.
  const runGenerate = (input: GenerateInput, replace: boolean) => {
    if (!selectedRouteId || !activeServiceId) return;
    const doomed = replace ? routeTrips.map((t) => t.trip_id) : [];
    const doomedSet = new Set(doomed);
    // Mint new IDs against everything that will SURVIVE the replace, so names
    // never collide with kept trips (other directions/services) yet still reuse
    // the numbers freed up by the trips we're about to drop.
    const params: GenerateTripsParams = {
      routeId: selectedRouteId, directionId, shapeId: mainGenShapeId, serviceId: activeServiceId,
      startTime: input.startTime, endTime: input.endTime, headwaySecs: input.headwaySecs, runSecs: input.runSecs,
      mode: input.mode, routeStops: mainPatternRouteStops, stops, shape, headsign: route?.route_short_name || undefined,
      tripIdPrefix: tripIdPrefixForRoute(route),
      existingTripIds: generateExistingIds(trips.map((t) => t.trip_id), doomed, replace),
    };
    const result = generateTrips(params);
    if (result.trips.length === 0) { say('Nothing to generate — check the inputs.'); return; }
    setDrawer(null);
    setModal(null);
    withUndo(() => {
      if (replace) {
        for (const id of doomed) removeTrip(id); // drops the trip + its stop_times
        const s = useStore.getState();
        s.setFrequencies(s.frequencies.filter((f) => !doomedSet.has(f.trip_id))); // removeTrip leaves frequencies behind
      }
      const st = useStore.getState();
      st.setTrips([...st.trips, ...result.trips]);
      st.setStopTimes([...st.stopTimes, ...result.stopTimes]);
      result.frequencies.forEach((f) => st.addFrequency(f));
      const made = input.mode === 'frequency'
        ? 'a reference trip + frequency window'
        : `${result.trips.length} trip${result.trips.length === 1 ? '' : 's'}`;
      if (replace) return `Replaced ${doomed.length} trip${doomed.length === 1 ? '' : 's'} with ${made}`;
      return input.mode === 'frequency' ? 'Created a reference trip + frequency window' : `Generated ${made}`;
    });
  };

  const applyGenerate = (input: GenerateInput) => {
    if (!selectedRouteId || !activeServiceId) return;
    if (routeTrips.length > 0) { setModal({ type: 'generate-confirm', input, existingCount: routeTrips.length }); return; }
    runGenerate(input, false);
  };

  const applyRuntime = ({ runMin, scoped }: { runMin: number; scoped: boolean }) => {
    if (!selectedRouteId || !activeServiceId) return;
    const ref: PatternRef = scoped
      ? { routeId: selectedRouteId, directionId, shapeId: mainGenShapeId, serviceId: activeServiceId }
      : { routeId: selectedRouteId, directionId, shapeId: mainGenShapeId };
    setDrawer(null);
    withUndo(() => {
      const n = applyPatternRunTime(ref, runMin * 60);
      return `Re-timed ${n} trip${n === 1 ? '' : 's'} to a ${runMin}-min run${scoped ? ' (this service day only)' : ''}`;
    });
  };

  // The "Set run time" drawer's Estimate mode: lay the whole pattern from the
  // road network (same estimation service as the per-trip ◷ action), keeping
  // each trip's start. Async (Map Matching); returns a status the drawer shows.
  const applyEstimate = async ({ dwellSec, speedFactor, scoped }: { dwellSec: number; speedFactor: number; scoped: boolean }): Promise<{ ok: boolean; error?: string }> => {
    if (!selectedRouteId || !activeServiceId) return { ok: false, error: 'Select a route first.' };
    if (orderedStops.length < 2) return { ok: false, error: 'Add at least two stops to this pattern first.' };
    const ref: PatternRef = scoped
      ? { routeId: selectedRouteId, directionId, shapeId: mainGenShapeId, serviceId: activeServiceId }
      : { routeId: selectedRouteId, directionId, shapeId: mainGenShapeId };
    let cum: number[] | null;
    try {
      cum = await estimateStopTravelByRoad(orderedStops.map((c) => [c.stop.stop_lon, c.stop.stop_lat] as [number, number]));
    } catch {
      return { ok: false, error: 'Something went wrong estimating times. Please try again.' };
    }
    if (!cum) return { ok: false, error: "Couldn't match this pattern to the road network. Try again, or set times manually." };
    const os = orderedStops.map((c) => ({ stopId: c.stop.stop_id, seq: c.seq }));
    const snap = snapshotFeed();
    const n = applyPatternEstimate(ref, os, cum, { dwellSec, speedFactor });
    if (n === 0) return { ok: false, error: 'No trips with times to estimate on this pattern.' };
    setDrawer(null);
    undoToast(`Estimated times for ${n} trip${n === 1 ? '' : 's'} from the road network`, snap);
    return { ok: true };
  };

  const applyRepeat = ({ headway, copies }: { headway: number; copies: number }) => {
    if (routeTrips.length === 0) return;
    setDrawer(null);
    withUndo(() => {
      const lastTrip = routeTrips[routeTrips.length - 1];
      const prefix = tripIdPrefixForRoute(route);
      const existingIds = new Set(trips.map((t) => t.trip_id));
      for (let i = 0; i < copies; i++) {
        const offsetMinutes = headway * (i + 1);
        const newId = mintTripId(prefix, existingIds);
        existingIds.add(newId);
        duplicateTrip(lastTrip.trip_id, newId, offsetMinutes);
      }
      return `Added ${copies} trip${copies === 1 ? '' : 's'}`;
    });
  };

  const onTool = (id: ToolId) => {
    if (id === 'removeall') setModal({ type: 'removeall' });
    else setDrawer((d) => (d === id ? null : id));
  };

  const handleCopyFromService = (sourceServiceId: string) => {
    if (!selectedRouteId || !activeServiceId) return;
    const prefix = tripIdPrefixForRoute(route);
    const existingIds = new Set(trips.map((t) => t.trip_id));
    const sourceTrips = trips.filter((t) => t.route_id === selectedRouteId && t.direction_id === directionId && t.service_id === sourceServiceId);
    for (const trip of sourceTrips) {
      const newId = mintTripId(prefix, existingIds);
      existingIds.add(newId);
      duplicateTrip(trip.trip_id, newId, 0);
      updateTrip(newId, { service_id: activeServiceId });
    }
    say(`Copied ${sourceTrips.length} trip${sourceTrips.length === 1 ? '' : 's'}`);
  };

  const onEditStops = () => {
    if (!selectedRouteId) return;
    const st = useStore.getState();
    st.setEditingRouteId(selectedRouteId);
    st.setRouteDetailTab('stops');
    st.setSidebarSection('routes');
    st.setRightRailOpen(true);
  };

  /* ---------- modal confirms ---------- */
  const [dupStartTime, setDupStartTime] = useState('');
  const [estStart, setEstStart] = useState('08:00');
  const [estDwell, setEstDwell] = useState(ESTIMATE_DEFAULTS.dwellSec);
  const [estSpeed, setEstSpeed] = useState(ESTIMATE_DEFAULTS.speedFactor);
  const [estimating, setEstimating] = useState(false);
  const [estError, setEstError] = useState<string | null>(null);

  // Seed the duplicate / estimate dialogs when they open.
  useEffect(() => {
    if (modal?.type === 'duplicate') {
      const d = paneData(modal.paneId);
      const first = d.getFirstDisplayedTime(modal.tripId);
      setDupStartTime(first ? formatTimeShort(secondsToGtfsTime(gtfsTimeToSeconds(first) + 3600)) : '');
    } else if (modal?.type === 'estimate') {
      const d = paneData(modal.paneId);
      const first = d.getFirstDisplayedTime(modal.tripId);
      setEstStart(first ? formatTimeShort(first) : '08:00');
      setEstError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  const confirmDuplicate = () => {
    if (modal?.type !== 'duplicate') return;
    const normalized = normalizeTimeInput(dupStartTime);
    if (!normalized) return;
    const d = paneData(modal.paneId);
    const firstTime = d.getFirstDisplayedTime(modal.tripId);
    const offsetMinutes = Math.round((gtfsTimeToSeconds(normalized) - gtfsTimeToSeconds(firstTime)) / 60);
    const newId = mintTripId(tripIdPrefixForRoute(route), new Set(trips.map((t) => t.trip_id)));
    duplicateTrip(modal.tripId, newId, offsetMinutes);
    setModal(null);
    say(`Duplicated ${modal.tripId} at ${normalized}`);
  };

  const confirmEstimate = async () => {
    if (modal?.type !== 'estimate') return;
    const d = paneData(modal.paneId);
    const normalized = normalizeTimeInput(estStart);
    if (!normalized) { setEstError('Enter a valid start time, e.g. 08:00.'); return; }
    if (d.orderedStops.length < 2) { setEstError('Add at least two stops to this route first.'); return; }
    setEstimating(true);
    setEstError(null);
    try {
      const coords = d.orderedStops.map((c) => [c.stop.stop_lon, c.stop.stop_lat] as [number, number]);
      const cum = await estimateStopTravelByRoad(coords);
      if (!cum) { setEstError("Couldn't match this route to the road network. Try again, or set times manually."); return; }
      const timings = layoutStopTimes(cum, { startSec: gtfsTimeToSeconds(normalized), dwellSec: Math.max(0, estDwell), speedFactor: Math.max(0.1, estSpeed) });
      const snap = snapshotFeed();
      timings.forEach((t, i) => {
        const col = d.orderedStops[i];
        if (!d.findStopTime(modal.tripId, col.seq)) return; // don't un-skip
        setStopTime(modal.tripId, col.stop.stop_id, col.seq, {
          arrival_time: secondsToGtfsTime(t.arrivalSec), departure_time: secondsToGtfsTime(t.departureSec),
        });
      });
      const doneMsg = `Estimated times for ${modal.tripId} from the road network`;
      setModal(null);
      undoToast(doneMsg, snap);
    } catch {
      setEstError('Something went wrong estimating times. Please try again.');
    } finally {
      setEstimating(false);
    }
  };

  const applyTargets = useMemo(() => {
    if (modal?.type !== 'applyall') return [];
    return paneData(modal.paneId).routeTrips.filter((t) => t.trip_id !== modal.tripId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, mainData, oppData]);

  const confirmApplyAll = () => {
    if (modal?.type !== 'applyall' || applyTargets.length === 0) { setModal(null); return; }
    const templateId = modal.tripId;
    const targetIds = applyTargets.map((t) => t.trip_id);
    setModal(null);
    withUndo(() => {
      applyTripPattern(templateId, targetIds);
      return `Applied ${templateId}'s pattern to ${targetIds.length} trip${targetIds.length === 1 ? '' : 's'}`;
    });
  };

  // In Both view, "Remove all trips" clears BOTH visible directions — otherwise
  // the companion (second) direction's trips are trapped with no way to remove
  // them. Single view is unchanged (the current direction only). The other bulk
  // tools stay main-pane-only by design (the companion is derived), which is
  // fine because they CREATE/retime trips rather than trapping existing ones.
  const removeAllAcrossBoth = oppositeOpen && hasOpposite && oppData.routeTrips.length > 0;
  const removeAllIds = removeAllAcrossBoth
    ? [...new Set([...routeTrips.map((t) => t.trip_id), ...oppData.routeTrips.map((t) => t.trip_id)])]
    : routeTrips.map((t) => t.trip_id);

  const confirmRemoveAll = () => {
    const doomed = removeAllIds;
    setModal(null);
    withUndo(() => {
      for (const id of doomed) removeTrip(id);
      return `Removed all ${doomed.length} trip${doomed.length === 1 ? '' : 's'}${removeAllAcrossBoth ? ' across both directions' : ''}`;
    });
  };

  // Swap inbound/outbound: flip direction_id (0↔1) on EVERY trip of the route and
  // its route_stops (so patterns re-derive consistently). Route-level, all
  // services. One-step Undo (the snapshot covers route_stops too).
  const routeDirCounts = useMemo(() => {
    let d0 = 0, d1 = 0;
    for (const t of trips) {
      if (t.route_id !== selectedRouteId) continue;
      if (t.direction_id === 1) d1 += 1; else d0 += 1;
    }
    return { d0, d1, total: d0 + d1 };
  }, [trips, selectedRouteId]);
  const confirmSwapDirections = () => {
    const rid = selectedRouteId;
    setModal(null);
    if (!rid) return;
    withUndo(() => {
      const st = useStore.getState();
      st.setTrips(swapRouteDirections(st.trips, rid));
      st.setRouteStops(swapRouteDirections(st.routeStops, rid));
      return `Swapped directions on ${route?.route_short_name || route?.route_long_name || rid} — flipped ${routeDirCounts.total} trip${routeDirCounts.total === 1 ? '' : 's'}`;
    });
  };

  /* ---------- render guards ---------- */
  if (!route) {
    if (routes.length > 0) selectRoute(routes[0].route_id);
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        {routes.length === 0 ? 'Create a route first' : 'Select a route to view its timetable'}
      </div>
    );
  }

  if (demandResponseOn && isFlexRoute(route, flexZones, routes)) {
    return (
      <div className="p-2 flex flex-col min-h-0 flex-1">
        <div className="shrink-0 mb-2 px-3">
          <Select
            value={route.route_id}
            onChange={(v) => selectRoute(v || null)}
            options={routes.map((r) => ({ id: r.route_id, name: r.route_short_name || r.route_long_name || r.route_id }))}
            aria-label="Route"
          />
        </div>
        <FlexTimetablePanel route={route} zone={findFlexZoneForRoute(route, flexZones, routes)} />
      </div>
    );
  }

  const allTripIds = trips.map((t) => t.trip_id);
  const ctxLabel = `${route.route_short_name || route.route_long_name || route.route_id} · ${directionName(route, directionId)} · ${calendars.find((c) => c.service_id === activeServiceId)?._description || activeServiceId || '—'}`;
  const siblingWithTrips = mainData.serviceIdsWithTrips.find((sid) => sid !== activeServiceId);

  const renderMainPane = () => {
    if (!mainData.hasStops) {
      return (
        <div className="flex-1 flex items-start justify-center pt-12 px-6 text-center text-sm text-warm-gray">
          Add stops to this route{directionId === 1 ? ' (inbound direction)' : ''} first.
        </div>
      );
    }
    if (routeTrips.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 px-8 py-8 text-center">
          <div className="w-[52px] h-[52px] rounded-2xl bg-coral-light flex items-center justify-center mb-2">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--color-coral)" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7 v5 l3 3" /></svg>
          </div>
          <div className="font-heading font-extrabold text-base text-dark-brown">No trips yet</div>
          <div className="text-[13px] text-warm-gray max-w-[360px] leading-relaxed">
            Generate a service pattern to get started — set a window and a headway, and we&rsquo;ll lay out the whole day.
          </div>
          <div className="flex gap-2.5 mt-3.5 flex-wrap justify-center">
            <Button variant="primary" icon="✨" onClick={() => setDrawer('generate')}>Generate trips</Button>
            <Button variant="secondary" icon="+" onClick={() => onAddTrip('main')}>Add a single trip</Button>
            {siblingWithTrips && (
              <Button variant="secondary" icon="⧉" onClick={() => handleCopyFromService(siblingWithTrips)}>
                Copy from {calendars.find((c) => c.service_id === siblingWithTrips)?._description || siblingWithTrips}
              </Button>
            )}
          </div>
        </div>
      );
    }
    return (
      <TimetableGridPane
        orderedStops={orderedStops}
        routeTrips={routeTrips}
        allTripIds={allTripIds}
        timepointStopIds={mainData.timepointStopIds}
        continuousOverrides={mainData.continuousOverrides}
        findStopTime={mainData.findStopTime}
        frequenciesByTrip={frequenciesByTrip}
        arrDepStops={arrDepStops}
        rowActions={rowActions}
        showHeadways={headwayHints}
        showColumnMenu
        showContinuous={showContinuous}
        scrollRef={mainScrollRef}
        onCell={(tripId, seq, stopId, field, v) => onCell('main', tripId, seq, stopId, field, v)}
        onSkip={(tripId, seq) => skipStop(tripId, seq)}
        onRestore={(tripId, seq, stopId) => setStopTime(tripId, stopId, seq, { arrival_time: '', departure_time: '' })}
        onRename={(tripId, id) => onRename(tripId, id)}
        onRowAction={(a, tripId) => onRowAction('main', a, tripId)}
        onAddTrip={() => onAddTrip('main')}
        onToggleRowActions={() => setRowActions(rowActions === 'strip' ? 'menu' : 'strip')}
        onToggleHeadways={() => setHeadwayHints(!headwayHints)}
        onTimepoint={(stopId, seq, on) => onTimepoint('main', stopId, seq, on)}
        onArrDep={onArrDep}
        onContinuous={onContinuous}
      />
    );
  };

  const renderCompanionPane = () => {
    if (!hasOpposite || !oppData.hasStops || oppData.routeTrips.length === 0) {
      return (
        <div className="flex-1 flex items-start justify-center pt-12 px-6 text-center text-sm text-warm-gray">
          No trips in the opposite direction for this service.
        </div>
      );
    }
    return (
      <TimetableGridPane
        orderedStops={oppData.orderedStops}
        routeTrips={oppData.routeTrips}
        allTripIds={allTripIds}
        timepointStopIds={oppData.timepointStopIds}
        continuousOverrides={oppData.continuousOverrides}
        findStopTime={oppData.findStopTime}
        frequenciesByTrip={frequenciesByTrip}
        arrDepStops={arrDepStops}
        rowActions={rowActions}
        showHeadways={headwayHints}
        showColumnMenu={false}
        showContinuous={showContinuous}
        scrollRef={oppScrollRef}
        onCell={(tripId, seq, stopId, field, v) => onCell('opp', tripId, seq, stopId, field, v)}
        onSkip={(tripId, seq) => skipStop(tripId, seq)}
        onRestore={(tripId, seq, stopId) => setStopTime(tripId, stopId, seq, { arrival_time: '', departure_time: '' })}
        onRename={(tripId, id) => onRename(tripId, id)}
        onRowAction={(a, tripId) => onRowAction('opp', a, tripId)}
        onAddTrip={() => onAddTrip('opp')}
        onToggleRowActions={() => setRowActions(rowActions === 'strip' ? 'menu' : 'strip')}
        onToggleHeadways={() => setHeadwayHints(!headwayHints)}
        onTimepoint={(stopId, seq, on) => onTimepoint('opp', stopId, seq, on)}
        onArrDep={onArrDep}
        onContinuous={onContinuous}
      />
    );
  };

  const companionOtherPatterns = patterns.filter((p) => p.shapeId !== effectiveShapeId);

  // Move the LEFT (main) pane onto a pattern — the shared action for the toolbar
  // direction control AND the left split header, so they stay in lockstep.
  const handleSelectPattern = (p: ShapePattern) => {
    setSelectedShapeId(p.shapeId);
    if (p.directionId !== directionId) setDirectionId(p.directionId);
  };
  // ⇄ Swap the left and right pane selections in one click. The old left becomes
  // the explicit right pick; the old right becomes the left.
  const handleSwapPanes = () => {
    const oldLeft = effectiveShapeId;
    const target = companionPattern;
    if (!target) return;
    handleSelectPattern(target);
    setCompanionShapeId(oldLeft);
  };

  // Honest per-pane accounting when a frequency template is in scope: how many
  // template trips, and the true rider-facing departures they build out to
  // (item #8). null when there are no frequency-based trips.
  const departureSummary = (tripsArr: Trip[]) => {
    let templates = 0, departures = 0;
    for (const t of tripsArr) {
      const w = frequenciesByTrip.get(t.trip_id);
      if (w && w.length) { templates += 1; departures += windowDepartureCount(w); }
      else departures += 1;
    }
    return templates > 0 ? { templates, departures } : null;
  };
  const mainSummary = departureSummary(routeTrips);
  const oppSummary = departureSummary(oppData.routeTrips);
  const summaryNote = (s: { templates: number; departures: number } | null) =>
    s ? `· ${s.templates} freq → ${s.departures} departures` : null;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <TimetableToolbar
        route={route}
        routes={routes}
        shapes={shapes}
        calendars={calendars}
        selectedRouteId={selectedRouteId}
        activeServiceId={activeServiceId}
        patterns={patterns}
        effectiveShapeId={effectiveShapeId}
        directionId={directionId}
        tripCount={routeTrips.length}
        departureNote={oppositeOpen ? null : summaryNote(mainSummary)}
        removeAllCount={removeAllIds.length}
        oppositeOpen={oppositeOpen}
        onSelectRoute={(id) => selectRoute(id)}
        onSelectService={(id) => setSelectedServiceId(id)}
        onSelectPattern={handleSelectPattern}
        onSelectDirection={(d) => setDirectionId(d)}
        onSetOpposite={(v) => setOppositeOpen(v)}
        canSwapDirections={routeDirCounts.total > 0}
        onSwapDirections={() => setModal({ type: 'swapdir' })}
        onEditStops={onEditStops}
        onTool={onTool}
      />

      {drawer === 'generate' && (
        <GenerateDrawer ctx={ctxLabel} endToEndDefault={endToEndDefault} getPreview={genPreview} onApply={applyGenerate} onCancel={() => setDrawer(null)} />
      )}
      {drawer === 'runtime' && (
        <RuntimeDrawer ctx={ctxLabel} currentRun={currentRunMin} tripCount={routeTrips.length} estimateDefaults={ESTIMATE_DEFAULTS} onApply={applyRuntime} onEstimate={applyEstimate} onCancel={() => setDrawer(null)} />
      )}
      {drawer === 'repeat' && (
        <RepeatDrawer
          lastStart={routeTrips.length ? formatTimeShort(mainData.getFirstDisplayedTime(routeTrips[routeTrips.length - 1].trip_id) || '') || '—' : '—'}
          tripCount={routeTrips.length}
          onApply={applyRepeat}
          onCancel={() => setDrawer(null)}
        />
      )}
      {drawer === 'frequency' && freqEditTripId && (
        <FrequencyDrawer
          ctx={ctxLabel}
          tripId={freqEditTripId}
          initialWindows={frequenciesByTrip.get(freqEditTripId) ?? []}
          onApply={(windows) => applyFrequency(freqEditTripId, windows)}
          onCancel={() => { setDrawer(null); setFreqEditTripId(null); }}
        />
      )}

      <div ref={splitContainerRef} className="flex-1 min-h-0 flex">
        <div
          ref={leftPaneRef}
          className={`min-w-0 flex flex-col min-h-0 ${oppositeOpen ? 'grow-0 shrink-0' : 'flex-1'}`}
          style={oppositeOpen ? { flexBasis: `${effectiveSplitRatio * 100}%`, minWidth: splitIsResizable ? SPLIT_MIN_PANE_PX : undefined } : undefined}
        >
          {/* In split view the main (left) pane gets its own header — a pattern
              dropdown in lockstep with the toolbar direction control (item #7),
              or a static label for a single-pattern route. Same 47px container as
              the companion header so both grids' column rows line up. */}
          {oppositeOpen && (
            <div className="shrink-0 flex items-center gap-2 px-3.5 h-[47px] border-b border-sand bg-cream font-heading font-extrabold text-xs text-dark-brown">
              {patterns.length >= 2 ? (
                <Select
                  value={effectiveShapeId ?? patterns[0].shapeId}
                  onChange={(v) => { const p = patterns.find((pp) => pp.shapeId === v); if (p) handleSelectPattern(p); }}
                  options={patterns.map((p) => ({ id: p.shapeId, name: directionName(route, p.directionId) }))}
                  aria-label="Left pane pattern"
                />
              ) : (
                <span>Direction {directionId} · {directionName(route, directionId)}</span>
              )}
              <span className="font-body font-normal text-[12.5px] text-warm-gray">{routeTrips.length} trips {summaryNote(mainSummary)}</span>
            </div>
          )}
          {renderMainPane()}
        </div>
        {oppositeOpen && (
          <SplitDivider
            resizable={splitIsResizable}
            onDrag={handleSplitDrag}
            onDragEnd={handleSplitDragEnd}
            onReset={handleSplitReset}
          />
        )}
        {oppositeOpen && (
          <div
            className="flex-1 min-w-0 flex flex-col min-h-0"
            style={splitIsResizable ? { minWidth: SPLIT_MIN_PANE_PX } : undefined}
          >
            <div className="shrink-0 flex items-center gap-2 px-3.5 h-[47px] border-b border-sand bg-cream font-heading font-extrabold text-xs text-dark-brown">
              {companionOtherPatterns.length > 1 && companionPattern ? (
                <Select
                  value={companionPattern.shapeId}
                  onChange={(v) => setCompanionShapeId(v)}
                  options={companionOtherPatterns.map((p) => ({ id: p.shapeId, name: directionName(route, p.directionId) }))}
                  aria-label="Companion pattern"
                />
              ) : (
                <span>Direction {companionDir} · {directionName(route, companionDir)}</span>
              )}
              <span className="font-body font-normal text-[12.5px] text-warm-gray">{oppData.routeTrips.length} trips {summaryNote(oppSummary)}</span>
              <div className="ml-auto flex items-center gap-2">
                {companionPattern && patterns.length >= 2 && (
                  <button
                    type="button"
                    onClick={handleSwapPanes}
                    title="Swap the left and right panes"
                    aria-label="Swap panes"
                    className="h-[22px] px-1.5 rounded-md border bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a] flex items-center justify-center"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 4L3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8" /></svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSyncScroll((v) => !v)}
                  title="Keep both panes' vertical scroll aligned, trip-for-trip"
                  className={`h-[22px] px-2.5 rounded-md border font-heading font-bold text-[11px] ${
                    syncScroll ? 'bg-coral-light border-coral text-[#d4603a]' : 'bg-white border-sand text-warm-gray'
                  }`}
                >
                  ⇅ Synced
                </button>
                {companionShapeId === null && (
                  <span className="font-mono text-[10px] uppercase tracking-wide text-warm-gray bg-white border border-sand px-1.5 py-0.5 rounded" title="Auto-derived — the opposite of the left pane; pick a pattern here to choose it explicitly">derived</span>
                )}
              </div>
            </div>
            {renderCompanionPane()}
          </div>
        )}
      </div>

      {/* Modals */}
      {modal?.type === 'duplicate' && (
        <Modal
          open
          onClose={() => setModal(null)}
          title={`Duplicate ${modal.tripId}`}
          description="Every stop time is offset by the same amount as the new start."
          maxWidthClassName="max-w-sm"
          footer={<>
            <AuthButton variant="secondary" onClick={() => setModal(null)}>Cancel</AuthButton>
            <AuthButton onClick={confirmDuplicate} disabled={!normalizeTimeInput(dupStartTime)}>Duplicate trip</AuthButton>
          </>}
        >
          <label className="flex items-center gap-2 text-sm text-brown">
            New trip starts at
            <input
              autoFocus
              value={dupStartTime}
              onChange={(e) => setDupStartTime(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmDuplicate(); }}
              className="w-[74px] px-2 py-1 border-2 border-sand rounded-md text-sm bg-cream focus:outline-none focus:border-coral font-mono tabular-nums"
            />
          </label>
        </Modal>
      )}

      {modal?.type === 'estimate' && (
        <Modal
          open
          onClose={() => setModal(null)}
          dismissable={!estimating}
          title={`Estimate times — ${modal.tripId}`}
          description="Fills stop times from real road-network driving time between stops (Mapbox). Skipped stops are computed through, but not written to."
          footer={<>
            {estError && <span className="text-red-500 text-xs mr-auto">{estError}</span>}
            <AuthButton variant="secondary" onClick={() => setModal(null)} disabled={estimating}>Cancel</AuthButton>
            <AuthButton onClick={confirmEstimate} disabled={estimating}>{estimating ? 'Estimating…' : 'Estimate times'}</AuthButton>
          </>}
        >
          <div className="flex items-center gap-2 text-sm text-brown flex-wrap">
            <span>Dwell</span>
            <input type="number" min={0} value={estDwell} onChange={(e) => setEstDwell(Math.max(0, Number(e.target.value)))} title="Seconds added at each stop for boarding/alighting" className="w-[54px] px-2 py-1 border-2 border-sand rounded-md text-sm bg-cream focus:outline-none focus:border-coral tabular-nums" />
            <span>sec per stop · bus runs</span>
            <input type="number" min={1} step={0.1} value={estSpeed} onChange={(e) => setEstSpeed(Math.max(0.1, Number(e.target.value)))} title="A bus is slower than a car — driving time is multiplied by this factor" className="w-[54px] px-2 py-1 border-2 border-sand rounded-md text-sm bg-cream focus:outline-none focus:border-coral tabular-nums" />
            <span>× slower than a car</span>
          </div>
        </Modal>
      )}

      {modal?.type === 'applyall' && (
        <ConfirmDialog
          title={`Apply ${modal.tripId} to all trips?`}
          body={<>Pushes <b>{modal.tripId}</b>&rsquo;s stop pattern and relative timing to the other <b>{applyTargets.length} trip{applyTargets.length === 1 ? '' : 's'}</b>. Each keeps its own start time.</>}
          confirmLabel={`Apply to ${applyTargets.length}`}
          confirmDisabled={applyTargets.length === 0}
          onConfirm={confirmApplyAll}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.type === 'removeall' && (
        <ConfirmDialog
          danger
          title={removeAllAcrossBoth ? 'Remove all trips across both directions?' : 'Remove all trips?'}
          body={removeAllAcrossBoth
            ? <>Deletes all <b>{removeAllIds.length} trip{removeAllIds.length === 1 ? '' : 's'}</b> on {route.route_short_name || route.route_long_name || route.route_id} — both {directionName(route, directionId).toLowerCase()} and {directionName(route, companionDir).toLowerCase()}. Stops and shapes are kept, so you can add fresh trips and replicate them.</>
            : <>Deletes all <b>{removeAllIds.length} trip{removeAllIds.length === 1 ? '' : 's'}</b> on {ctxLabel}. Stops and shape are kept, so you can add a fresh trip and replicate it.</>}
          confirmLabel={`Remove ${removeAllIds.length} trip${removeAllIds.length === 1 ? '' : 's'}`}
          onConfirm={confirmRemoveAll}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.type === 'swapdir' && (
        <ConfirmDialog
          title="Swap inbound and outbound?"
          body={<>Flips the direction of every trip on {route.route_short_name || route.route_long_name || route.route_id}: <b>{routeDirCounts.d0} {directionName(route, 0).toLowerCase()}</b> ↔ <b>{routeDirCounts.d1} {directionName(route, 1).toLowerCase()}</b>. Use this when the feed labels the directions the wrong way round. One Undo puts it back.</>}
          confirmLabel={`Swap ${routeDirCounts.total} trip${routeDirCounts.total === 1 ? '' : 's'}`}
          onConfirm={confirmSwapDirections}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.type === 'generate-confirm' && (
        <Modal
          open
          onClose={() => setModal(null)}
          title="Replace the existing trips?"
          showClose={false}
          footer={
            <>
              <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
              <Button variant="secondary" onClick={() => runGenerate(modal.input, false)}>Add alongside</Button>
              <Button variant="primary" onClick={() => runGenerate(modal.input, true)}>
                Replace {modal.existingCount} trip{modal.existingCount === 1 ? '' : 's'}
              </Button>
            </>
          }
        >
          <div className="text-sm text-warm-gray">
            {ctxLabel} already has <b>{modal.existingCount} trip{modal.existingCount === 1 ? '' : 's'}</b>. Replace
            them with the freshly generated service, or add the new trips alongside what&rsquo;s already there?
          </div>
        </Modal>
      )}

      {toast && <Toast toast={toast} />}
      {cascade && (
        <div className="fixed bottom-[18px] left-1/2 -translate-x-1/2 z-[210] flex items-center gap-2.5 pl-[18px] pr-2 py-[7px] bg-white border border-sand rounded-full shadow-[0_8px_28px_rgba(61,46,34,0.18)] text-[13px] text-brown whitespace-nowrap">
          <span>Shift the <b>{cascade.laterIds.length} later trip{cascade.laterIds.length === 1 ? '' : 's'}</b> at {cascade.stopName} by <b>{cascade.deltaMin > 0 ? '+' : ''}{cascade.deltaMin} min</b> too?</span>
          <Button variant="primary" onClick={applyCascade}>Shift</Button>
          <Button variant="ghost" onClick={() => setCascade(null)}>Dismiss</Button>
        </div>
      )}
    </div>
  );
}
