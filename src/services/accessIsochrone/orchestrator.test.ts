import { describe, expect, it } from 'vitest';
import type { AccessIsochroneParams } from './types';
import type { AccessFeedInput } from './orchestrator';
import { runAccessIsochrone } from './orchestrator';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Feed setup ───────────────────────────────────────────────────────────────
//
// Geometry (all on the latitude axis, lon=0):
//   Origin:  lat=0.000   lon=0.000
//   S1:      lat=0.001   lon=0.000   ≈ 111 m from origin  (within 5-min walk = 400 m)
//   S2:      lat=0.010   lon=0.000   ≈ 1111 m             (outside walk radius)
//   S3:      lat=0.040   lon=0.000   ≈ 4444 m             (outside walk radius)
//
// Trips (service_id='SVC'):
//   T1: S1 → S2   departs S1 at 28,900 s, arrives S2 at 29,500 s
//   T2: S2 → S3   departs S2 at 29,600 s, arrives S3 at 30,400 s
//
// departureSec = 28,800 (8 AM).
// Walk to S1 ≈ 111 m ÷ 80 m/min × 60 = 83.25 s → arrivalSec at S1 ≈ 28,883.
// T1 departs S1 at 28,900 ≥ 28,883. ✓
//
// Budget 15 min (900 s):  cutoff = 28,800 + 900 = 29,700
//   S1 reached at ≈28,883 ≤ 29,700 ✓
//   S2 reached at 29,500 ≤ 29,700  ✓
//   S3 reached at 30,400 > 29,700  ✗
//
// Budget 30 min (1800 s): cutoff = 28,800 + 1800 = 30,600
//   S3 reached at 30,400 ≤ 30,600  ✓
//
// So reachedStops: 15 min → {S1, S2}; 30 min → {S1, S2, S3} (monotonically grows).

const DEPARTURE_SEC = 28_800;

const feed: AccessFeedInput = {
  stops: [
    { stop_id: 'S1', stop_lat: 0.001, stop_lon: 0.0, parent_station: undefined },
    { stop_id: 'S2', stop_lat: 0.01, stop_lon: 0.0, parent_station: undefined },
    { stop_id: 'S3', stop_lat: 0.04, stop_lon: 0.0, parent_station: undefined },
  ],
  trips: [
    { trip_id: 'T1', route_id: 'R1', service_id: 'SVC' },
    { trip_id: 'T2', route_id: 'R2', service_id: 'SVC' },
  ],
  stopTimes: [
    // T1: S1 → S2
    {
      trip_id: 'T1',
      stop_id: 'S1',
      stop_sequence: 1,
      arrival_time: hms(28_900),
      departure_time: hms(28_900),
    },
    {
      trip_id: 'T1',
      stop_id: 'S2',
      stop_sequence: 2,
      arrival_time: hms(29_500),
      departure_time: hms(29_500),
    },
    // T2: S2 → S3
    {
      trip_id: 'T2',
      stop_id: 'S2',
      stop_sequence: 1,
      arrival_time: hms(29_600),
      departure_time: hms(29_600),
    },
    {
      trip_id: 'T2',
      stop_id: 'S3',
      stop_sequence: 2,
      arrival_time: hms(30_400),
      departure_time: hms(30_400),
    },
  ],
};

const baseParams: AccessIsochroneParams = {
  origin: { lon: 0.0, lat: 0.0 },
  budgetsMin: [30, 15], // deliberately unsorted to test sorting
  departureSec: DEPARTURE_SEC,
  serviceIds: ['SVC'],
  walkMinutes: 5, // 5 min × 80 m/min = 400 m radius
  straightLineWalk: true,
  maxRounds: 4,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runAccessIsochrone — straight-line mode, no block groups', () => {
  it('returns status ok', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    expect(result.status).toBe('ok');
  });

  it('origin is preserved in result', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    expect(result.origin).toEqual({ lon: 0.0, lat: 0.0 });
  });

  it('rings are sorted ascending by budgetMin', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    expect(result.rings).toHaveLength(2);
    expect(result.rings[0].budgetMin).toBe(15);
    expect(result.rings[1].budgetMin).toBe(30);
  });

  it('boardableStopIds contains only S1 (within 400 m)', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    // S1 ≈ 111 m ≤ 400 m ✓;  S2 ≈ 1111 m > 400 m ✗;  S3 ≈ 4444 m > 400 m ✗
    expect(result.boardableStopIds).toContain('S1');
    expect(result.boardableStopIds).not.toContain('S2');
    expect(result.boardableStopIds).not.toContain('S3');
  });

  it('reached stops grow monotonically with budget', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    const r15 = result.rings[0]; // 15 min
    const r30 = result.rings[1]; // 30 min
    expect(r30.reachedStopIds.length).toBeGreaterThanOrEqual(r15.reachedStopIds.length);
  });

  it('15-min ring contains S1 and S2 but not S3', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    const ring15 = result.rings[0];
    expect(ring15.reachedStopIds).toContain('S1');
    expect(ring15.reachedStopIds).toContain('S2');
    expect(ring15.reachedStopIds).not.toContain('S3');
  });

  it('30-min ring additionally contains S3', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    const ring30 = result.rings[1];
    expect(ring30.reachedStopIds).toContain('S1');
    expect(ring30.reachedStopIds).toContain('S2');
    expect(ring30.reachedStopIds).toContain('S3');
  });

  it('coverage is null when blockGroups is empty', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    for (const ring of result.rings) {
      expect(ring.coverage).toBeNull();
    }
  });

  it('straight-line mode produces 0 isochrone requests', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    expect(result.isochroneRequests).toBe(0);
  });

  it('ring polygons are non-null when stops are reachable', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    // Both rings have reached stops, so polygons should be produced.
    expect(result.rings[0].polygon).not.toBeNull();
    expect(result.rings[1].polygon).not.toBeNull();
  });

  it('reachedStopCount is the distinct count across ALL rings', async () => {
    const result = await runAccessIsochrone(baseParams, feed, []);
    // All three stops are reached across all rings.
    expect(result.reachedStopCount).toBe(3);
  });
});

describe('runAccessIsochrone — empty / error cases', () => {
  it('returns status empty when no stops are within walking distance', async () => {
    const farOrigin = { ...baseParams, origin: { lon: 50.0, lat: 50.0 } };
    const result = await runAccessIsochrone(farOrigin, feed, []);
    expect(result.status).toBe('empty');
    expect(result.boardableStopIds).toHaveLength(0);
    expect(result.reachedStopCount).toBe(0);
  });

  it('with inactive serviceIds: S1 is still seeded by walk → ok, S2/S3 unreachable', async () => {
    // S1 is within walking distance so it is seeded into arrivals; status='ok'
    // because at least one stop was reached (the spec says "ok if any stop reached").
    // S2 and S3 are outside the walk radius and unreachable without transit.
    const noService = { ...baseParams, serviceIds: ['NO_SUCH_SERVICE'] };
    const result = await runAccessIsochrone(noService, feed, []);
    expect(result.status).toBe('ok');
    expect(result.reachedStopCount).toBeGreaterThan(0); // S1 counts
    for (const ring of result.rings) {
      expect(ring.reachedStopIds).not.toContain('S2');
      expect(ring.reachedStopIds).not.toContain('S3');
    }
  });

  it('rings are always returned (ascending) even on empty result', async () => {
    const farOrigin = { ...baseParams, origin: { lon: 50.0, lat: 50.0 } };
    const result = await runAccessIsochrone(farOrigin, feed, []);
    expect(result.rings).toHaveLength(2);
    expect(result.rings[0].budgetMin).toBe(15);
    expect(result.rings[1].budgetMin).toBe(30);
  });

  it('status is error (not thrown) when an internal error occurs', async () => {
    // Pass a malformed feed to trigger an internal error gracefully.
    const badFeed = { stops: null as unknown as AccessFeedInput['stops'], trips: [], stopTimes: [] };
    const result = await runAccessIsochrone(baseParams, badFeed, []);
    expect(result.status).toBe('error');
    expect(result.message).toBeTruthy();
  });
});
