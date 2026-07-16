// Shared frequency build-out: expand a frequencies.txt-driven template trip into
// its full run of projected departures. One pure module, two consumers — the
// timetable grid (item #8) and the Visualization / Marey view (item #10). The
// projections are DERIVED, never stored or exported; only the template trip is
// real, editable data.
//
// GTFS semantics: the template's stop_times give the relative timing (durations
// between stops); each projected trip is that pattern shifted so its first stop
// departs at `start_time + k*headway_secs`, for every k with that time strictly
// before the window's `end_time`. Multiple frequencies rows for one trip expand
// each window.

import type { Frequency, StopTime } from '../types/gtfs';
import { gtfsTimeToSeconds, secondsToGtfsTime } from '../utils/time';

export type FrequencyWindow = Pick<Frequency, 'start_time' | 'end_time' | 'headway_secs' | 'exact_times'>;

export interface VirtualTrip {
  /** The real template trip this projection derives from. */
  templateTripId: string;
  /** Stable, unique React key for the projected row. */
  key: string;
  /** First-stop departure of this projection, in seconds. */
  departureSec: number;
  /** The window's headway (seconds) — for the "every Nm" derived-row tooltip. */
  headwaySecs: number;
  /** 0 = approximate headway (show a cue), 1 = exact. */
  exactTimes: 0 | 1;
  /** The template's stop_times shifted onto this departure (same stop_ids/seqs). */
  stopTimes: StopTime[];
}

/** Earliest set arrival/departure (seconds) across a trip's stop_times, or null
 *  when it has no times yet. This is the template's anchor departure. */
export function templateStartSec(stopTimes: StopTime[]): number | null {
  let best: number | null = null;
  for (const st of stopTimes) {
    const t = st.departure_time || st.arrival_time;
    if (t) {
      const s = gtfsTimeToSeconds(t);
      if (best == null || s < best) best = s;
    }
  }
  return best;
}

const shift = (hms: string, deltaSec: number): string =>
  hms ? secondsToGtfsTime(gtfsTimeToSeconds(hms) + deltaSec) : hms;

/** Total projected departures across a set of windows (INCLUDING the departure
 *  that coincides with the template row) — for the honest "→ M departures"
 *  header summary. */
export function windowDepartureCount(windows: FrequencyWindow[]): number {
  let n = 0;
  for (const w of windows) {
    const start = gtfsTimeToSeconds(w.start_time);
    const end = gtfsTimeToSeconds(w.end_time);
    if (w.headway_secs > 0 && end > start) n += Math.ceil((end - start) / w.headway_secs);
  }
  return n;
}

/** Expand a frequency-based trip into its projected departures. Skips the
 *  departure that coincides with the template's own first departure — that's the
 *  editable template row, shown separately. Sorted ascending by departure. Pure:
 *  returns plain objects that never enter the store or the export. */
export function expandFrequencyTrip(
  templateTripId: string,
  templateStopTimes: StopTime[],
  windows: FrequencyWindow[],
): VirtualTrip[] {
  const ordered = [...templateStopTimes].sort((a, b) => a.stop_sequence - b.stop_sequence);
  const tStart = templateStartSec(ordered);
  if (tStart == null) return [];
  const out: VirtualTrip[] = [];
  windows.forEach((w, wi) => {
    const start = gtfsTimeToSeconds(w.start_time);
    const end = gtfsTimeToSeconds(w.end_time);
    const h = w.headway_secs;
    if (!(h > 0) || !(end > start)) return;
    let k = 0;
    for (let t = start; t < end; t += h, k += 1) {
      if (t === tStart) continue; // the editable template row itself
      const offset = t - tStart;
      out.push({
        templateTripId,
        key: `${templateTripId}~f${wi}k${k}`,
        departureSec: t,
        headwaySecs: h,
        exactTimes: (w.exact_times ?? 0) as 0 | 1,
        stopTimes: ordered.map((st) => ({
          ...st,
          arrival_time: shift(st.arrival_time, offset),
          departure_time: shift(st.departure_time, offset),
        })),
      });
    }
  });
  return out.sort((a, b) => a.departureSec - b.departureSec);
}
