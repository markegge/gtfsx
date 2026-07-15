import { describe, expect, it } from 'vitest';
import type { RaptorFeedInput } from './types';
import { buildRaptorIndex, runRaptor } from './raptor';

// ─── Tiny feed builder helpers ────────────────────────────────────────────────

/** Convert seconds to GTFS HH:MM:SS string (handles times > 86400). */
function hms(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0')
  );
}

/** Build a minimal stop-time entry. */
function st(
  trip_id: string,
  stop_id: string,
  seq: number,
  arrSec: number,
  depSec = arrSec,
) {
  return {
    trip_id,
    stop_id,
    stop_sequence: seq,
    arrival_time: hms(arrSec),
    departure_time: hms(depSec),
  };
}

// ─── Test 1: Single direct route A → B → C ───────────────────────────────────

describe('runRaptor — single straight route A→B→C', () => {
  // Trip: departs A at t=1000, arrives B at 1100, departs B at 1110, arrives C at 1200.
  const feed: RaptorFeedInput = {
    stops: [
      { stop_id: 'A', stop_lat: 0, stop_lon: 0, parent_station: undefined },
      { stop_id: 'B', stop_lat: 0, stop_lon: 0.01, parent_station: undefined },
      { stop_id: 'C', stop_lat: 0, stop_lon: 0.02, parent_station: undefined },
    ],
    trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'SVC' }],
    stopTimes: [
      st('T1', 'A', 1, 1000, 1000),
      st('T1', 'B', 2, 1100, 1110),
      st('T1', 'C', 3, 1200, 1200),
    ],
  };
  const serviceIds = new Set(['SVC']);
  const idx = buildRaptorIndex(feed, serviceIds);

  it('buildRaptorIndex exposes the three stop ids', () => {
    expect(new Set(idx.stopIds)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('runRaptor reaches B and C with correct earliest arrivals', () => {
    // Source arrives at A at t=900, well before the 1000 departure.
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 900 }]);
    expect(arrivals.get('A')).toBe(900); // seed preserved
    expect(arrivals.get('B')).toBe(1100);
    expect(arrivals.get('C')).toBe(1200);
  });

  it('does not reach stops when source arrives after the last trip', () => {
    // Source at t=1500 — trip already gone.
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 1500 }]);
    expect(arrivals.get('B')).toBeUndefined();
    expect(arrivals.get('C')).toBeUndefined();
  });

  it('respects cutoffSec — stops pruned when arrival exceeds cutoff', () => {
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 900 }], {
      cutoffSec: 1150, // C arrives at 1200 > 1150
    });
    expect(arrivals.get('B')).toBe(1100); // arrived 1100 ≤ 1150 ✓
    expect(arrivals.get('C')).toBeUndefined(); // pruned
  });
});

// ─── Test 2: Two-route transfer requires maxRounds ≥ 2 ───────────────────────

describe('runRaptor — two-route transfer A→B→C', () => {
  // Route 1: A→B (trip T1, departs A at 100, arrives B at 200)
  // Route 2: B→C (trip T2, departs B at 300, arrives C at 400)
  // Reaching C requires boarding T1 first, alighting at B, then boarding T2.
  const feed: RaptorFeedInput = {
    stops: [
      { stop_id: 'A', stop_lat: 0, stop_lon: 0, parent_station: undefined },
      { stop_id: 'B', stop_lat: 0, stop_lon: 0.01, parent_station: undefined },
      { stop_id: 'C', stop_lat: 0, stop_lon: 0.02, parent_station: undefined },
    ],
    trips: [
      { trip_id: 'T1', route_id: 'R1', service_id: 'SVC' },
      { trip_id: 'T2', route_id: 'R2', service_id: 'SVC' },
    ],
    stopTimes: [
      st('T1', 'A', 1, 100, 100),
      st('T1', 'B', 2, 200, 200),
      st('T2', 'B', 1, 300, 300),
      st('T2', 'C', 2, 400, 400),
    ],
  };
  const serviceIds = new Set(['SVC']);
  const source = [{ stopId: 'A', arrivalSec: 50 }];

  it('reaches C with maxRounds ≥ 2', () => {
    const idx = buildRaptorIndex(feed, serviceIds);
    const arrivals = runRaptor(idx, source, { maxRounds: 2 });
    expect(arrivals.get('B')).toBe(200);
    expect(arrivals.get('C')).toBe(400);
  });

  it('does NOT reach C with maxRounds = 1 (only direct legs)', () => {
    const idx = buildRaptorIndex(feed, serviceIds);
    const arrivals = runRaptor(idx, source, { maxRounds: 1 });
    expect(arrivals.get('B')).toBe(200); // reachable in 1 round
    expect(arrivals.get('C')).toBeUndefined(); // needs a second round
  });
});

// ─── Test 3: Frequency expansion — later source catches a later run ───────────

describe('runRaptor — frequency-based trip expansion', () => {
  // Template trip T1: A departs 3000, B arrives 3600.
  // Frequency window: start=3000, end=7000, headway=2000.
  // → Synthetic trip 1: A departs 3000, B arrives 3600.
  // → Synthetic trip 2: A departs 5000, B arrives 5600.  (offset +2000)
  // → No trip at 7000 (< end_time strictly).
  const feed: RaptorFeedInput = {
    stops: [
      { stop_id: 'A', stop_lat: 0, stop_lon: 0, parent_station: undefined },
      { stop_id: 'B', stop_lat: 0, stop_lon: 0.01, parent_station: undefined },
    ],
    trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'SVC' }],
    stopTimes: [
      st('T1', 'A', 1, 3000, 3000),
      st('T1', 'B', 2, 3600, 3600),
    ],
    frequencies: [
      {
        trip_id: 'T1',
        start_time: hms(3000),
        end_time: hms(7000),
        headway_secs: 2000,
      },
    ],
  };
  const serviceIds = new Set(['SVC']);

  it('source arriving before first departure catches the first synthetic trip', () => {
    const idx = buildRaptorIndex(feed, serviceIds);
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 2900 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBe(3600); // first synthetic trip
  });

  it('source arriving after first trip still catches the second synthetic trip', () => {
    const idx = buildRaptorIndex(feed, serviceIds);
    // Arrives at A at 4500 — after trip 1 departed 3000 but before trip 2 at 5000.
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 4500 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBe(5600); // second synthetic trip (3600 + 2000)
  });

  it('source arriving after all synthetic trips does not reach B', () => {
    const idx = buildRaptorIndex(feed, serviceIds);
    // Trip 2 departs 5000; no trip at or after 7000.
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 6000 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBeUndefined();
  });
});

// ─── Test 4: Service-day filtering — inactive service_id trips are ignored ────

describe('buildRaptorIndex — service-day filtering', () => {
  // Two trips on the same stop pattern but different service_ids.
  // tripA (SUN): A departs 100, B arrives 150.
  // tripB (MON): A departs 200, B arrives 250.
  const feed: RaptorFeedInput = {
    stops: [
      { stop_id: 'A', stop_lat: 0, stop_lon: 0, parent_station: undefined },
      { stop_id: 'B', stop_lat: 0, stop_lon: 0.01, parent_station: undefined },
    ],
    trips: [
      { trip_id: 'tripA', route_id: 'R1', service_id: 'SUN' },
      { trip_id: 'tripB', route_id: 'R1', service_id: 'MON' },
    ],
    stopTimes: [
      st('tripA', 'A', 1, 100, 100),
      st('tripA', 'B', 2, 150, 150),
      st('tripB', 'A', 1, 200, 200),
      st('tripB', 'B', 2, 250, 250),
    ],
  };

  it('with MON service only: arrival at B uses tripB times (250)', () => {
    const idx = buildRaptorIndex(feed, new Set(['MON']));
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 50 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBe(250); // only tripB is active
  });

  it('with SUN service only: arrival at B uses tripA times (150)', () => {
    const idx = buildRaptorIndex(feed, new Set(['SUN']));
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 50 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBe(150); // only tripA is active
  });

  it('with empty service set: no trips active, B is unreachable', () => {
    const idx = buildRaptorIndex(feed, new Set<string>());
    // stopIds should be empty (no active trips)
    expect(idx.stopIds).toHaveLength(0);
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 50 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBeUndefined();
  });

  it('with both services active: arrival at B is 150 (earlier tripA wins)', () => {
    const idx = buildRaptorIndex(feed, new Set(['SUN', 'MON']));
    // Source at A=50, both trips indexed; earliest boarding catches tripA at 100.
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 50 }], { maxRounds: 1 });
    expect(arrivals.get('B')).toBe(150);
  });
});

// ─── Test 5: minTransferSec enforced at transfers ─────────────────────────────

describe('runRaptor — minTransferSec', () => {
  // Route 1: A→B. Route 2: B→C.
  // T1: A→B, departs A at 100, arrives B at 200.
  // T2: B→C, departs B at 210, arrives C at 310.
  // With minTransferSec=0 (default): boarding T2 at B is possible (210 ≥ 200+0).
  // With minTransferSec=60: boarding T2 at B requires dep ≥ 200+60=260; T2 departs
  //   at 210 < 260, so C is not reachable.
  const feed: RaptorFeedInput = {
    stops: [
      { stop_id: 'A', stop_lat: 0, stop_lon: 0, parent_station: undefined },
      { stop_id: 'B', stop_lat: 0, stop_lon: 0.01, parent_station: undefined },
      { stop_id: 'C', stop_lat: 0, stop_lon: 0.02, parent_station: undefined },
    ],
    trips: [
      { trip_id: 'T1', route_id: 'R1', service_id: 'SVC' },
      { trip_id: 'T2', route_id: 'R2', service_id: 'SVC' },
    ],
    stopTimes: [
      st('T1', 'A', 1, 100, 100),
      st('T1', 'B', 2, 200, 200),
      st('T2', 'B', 1, 210, 210),
      st('T2', 'C', 2, 310, 310),
    ],
  };
  const idx = buildRaptorIndex(feed, new Set(['SVC']));

  it('with minTransferSec=0: C is reachable (tight connection honoured)', () => {
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 50 }], {
      maxRounds: 2,
      minTransferSec: 0,
    });
    expect(arrivals.get('C')).toBe(310);
  });

  it('with minTransferSec=60: C is unreachable (missed connection)', () => {
    const arrivals = runRaptor(idx, [{ stopId: 'A', arrivalSec: 50 }], {
      maxRounds: 2,
      minTransferSec: 60,
    });
    // B arrived at 200; earliest trip at B departing ≥ 200+60=260 → none.
    expect(arrivals.get('C')).toBeUndefined();
  });
});
