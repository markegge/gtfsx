import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Toast, type ToastState } from '../ui/Toast';
import { computeFrequencyConversion, type ConversionResult } from '../../services/frequencyConversion';

/**
 * App-level host for the frequency → trips converter (issue #65). Both entry
 * points — the timetable's per-template "Convert to trips…" row action and the
 * Blocks tab's all-frequency / mixed-scope notices — dispatch through the store
 * (`requestFrequencyConversion(tripIds)`); this single mount owns the confirm
 * dialog, the one-commit apply, and the snapshot Undo toast, so the flow is
 * identical from either place and works whichever bottom-panel tab is showing.
 * Mounted once in AppShell (mirrors RouteDeleteDialog).
 */
export function FrequencyConvertDialog() {
  const tripIds = useStore((s) => s.frequencyConvertTripIds);
  const clear = useStore((s) => s.clearFrequencyConversionRequest);
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const frequencies = useStore((s) => s.frequencies);
  const routes = useStore((s) => s.routes);
  const applyFrequencyConversion = useStore((s) => s.applyFrequencyConversion);

  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const result = useMemo<ConversionResult | null>(() => {
    if (!tripIds || tripIds.length === 0) return null;
    return computeFrequencyConversion({ templateTripIds: tripIds, trips, stopTimes, frequencies, routes });
  }, [tripIds, trips, stopTimes, frequencies, routes]);

  // A pending request that resolves to nothing convertible (e.g. the template
  // lost its frequency between click and now) is dropped silently.
  useEffect(() => {
    if (tripIds && result && result.removedTemplateIds.length === 0) clear();
  }, [tripIds, result, clear]);

  const showToast = (message: string, onUndo?: () => void) => {
    setToast({ message, onUndo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), onUndo ? 6500 : 1800);
  };

  const confirm = () => {
    if (!result || result.removedTemplateIds.length === 0) { clear(); return; }
    // Snapshot the affected arrays BEFORE applying (immer keeps replaced arrays
    // immutable, so holding the references is a valid point-in-time snapshot).
    const snapTrips = trips, snapStops = stopTimes, snapFreqs = frequencies;
    applyFrequencyConversion(result);
    clear();
    showToast(convertedMessage(result), () => {
      const s = useStore.getState();
      s.setTrips(snapTrips);
      s.setStopTimes(snapStops);
      s.setFrequencies(snapFreqs);
      showToast('Conversion undone');
    });
  };

  const open = !!(tripIds && result && result.removedTemplateIds.length > 0);

  return (
    <>
      {open && result && (
        <ConfirmDialog
          title={confirmTitle(result)}
          body={confirmBody(result)}
          confirmLabel={`Convert to ${result.totalResultTrips} trip${result.totalResultTrips === 1 ? '' : 's'}`}
          onConfirm={confirm}
          onCancel={clear}
        />
      )}
      {toast && <Toast toast={toast} />}
    </>
  );
}

function confirmTitle(r: ConversionResult): string {
  if (r.perTemplate.length === 1) {
    return `Convert ${r.perTemplate[0].templateTripId} to individual trips?`;
  }
  return `Convert ${r.perTemplate.length} frequency templates to individual trips?`;
}

function confirmBody(r: ConversionResult) {
  const single = r.perTemplate.length === 1;
  const lead = single
    ? (
      <>
        Converts <b>{r.perTemplate[0].templateTripId}</b>&rsquo;s frequency into{' '}
        <b>{r.perTemplate[0].totalTripCount} individual trip{r.perTemplate[0].totalTripCount === 1 ? '' : 's'}</b>.
      </>
    )
    : (
      <>
        Converts <b>{r.perTemplate.length} frequency templates</b> into{' '}
        <b>{r.totalResultTrips} individual trips</b> in total.
      </>
    );
  return (
    <>
      {lead}{' '}
      The schedule looks the same, but every trip becomes real and editable — you can block them, edit
      each one, and their service-hours count toward cost. The <code>frequencies.txt</code> rows are removed.
      {r.anyApproximate && (
        <span className="block mt-2 text-amber-700">
          These are approximate (&ldquo;about every N minutes&rdquo;) headways — converting writes them as
          exact scheduled departure times.
        </span>
      )}
    </>
  );
}

function convertedMessage(r: ConversionResult): string {
  if (r.perTemplate.length === 1) {
    return `Converted ${r.perTemplate[0].templateTripId} into ${r.perTemplate[0].totalTripCount} trips`;
  }
  return `Converted ${r.perTemplate.length} templates into ${r.totalResultTrips} trips`;
}
