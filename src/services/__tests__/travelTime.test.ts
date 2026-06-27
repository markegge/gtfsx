// Tests for travelTime.ts: the Mapbox Directions per-leg driving-time estimate
// (with its >25-stop chunk/stitch logic) and the dwell/speed-factor timing
// layout. The Directions fetch is mocked; we assert the chunks stitch with no
// gap or double-count and that a failed fetch returns null.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateStopTravelByRoad, layoutStopTimes } from '../travelTime';

type LngLat = [number, number];

// Stops live on a line at lng = i * 0.01 so the mock can recover each stop's
// global index from its coordinate. Leg (j → j+1) gets duration (j + 1) seconds:
// distinct per leg, so any gap or double-count across a chunk boundary changes
// the cumulative sum and fails the assertions below.
function stopsAt(n: number): LngLat[] {
  return Array.from({ length: n }, (_, i) => [i * 0.01, 0] as LngLat);
}

// Parse the Directions URL, derive each waypoint's global index from its lng,
// and return one leg per consecutive pair with duration = (fromIndex + 1).
function directionsResponse(url: string) {
  const path = url.split('/driving/')[1].split('?')[0];
  const coords = path.split(';').map((c) => Math.round(parseFloat(c.split(',')[0]) / 0.01));
  const legs: { duration: number }[] = [];
  for (let i = 0; i < coords.length - 1; i++) legs.push({ duration: coords[i] + 1 });
  return {
    ok: true,
    json: async () => ({ code: 'Ok', routes: [{ legs }] }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('estimateStopTravelByRoad', () => {
  it('returns cumulative per-leg driving seconds in order for a short route', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => directionsResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);

    const cum = await estimateStopTravelByRoad(stopsAt(4));
    // legs are 1,2,3 → cumulative 0,1,3,6
    expect(cum).toEqual([0, 1, 3, 6]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one request, well under 25 stops
  });

  it('splits a 30-stop route into overlapping chunks that stitch with no gap or double-count', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => directionsResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);

    const cum = await estimateStopTravelByRoad(stopsAt(30));

    // 30 stops → 29 legs → 30 cumulative entries.
    expect(cum).not.toBeNull();
    expect(cum).toHaveLength(30);

    // Two requests: stops 0..24 (25 coords, the max) then stops 24..29.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCoordCount = String(fetchMock.mock.calls[0][0]).split('/driving/')[1].split('?')[0].split(';').length;
    const secondCoordCount = String(fetchMock.mock.calls[1][0]).split('/driving/')[1].split('?')[0].split(';').length;
    expect(firstCoordCount).toBe(25);          // capped at the Mapbox limit
    expect(secondCoordCount).toBe(6);          // stops 24..29 inclusive (overlap by 1)
    expect(firstCoordCount).toBeLessThanOrEqual(25);
    expect(secondCoordCount).toBeLessThanOrEqual(25);

    // Closed-form: leg (j→j+1) = j+1, so cum[i] = i(i+1)/2. The boundary leg
    // (stop 24→25 = 25) must appear EXACTLY once: cum[25]-cum[24] === 25.
    for (let i = 0; i < 30; i++) expect(cum![i]).toBe((i * (i + 1)) / 2);
    expect(cum![25] - cum![24]).toBe(25);      // boundary leg counted once, no gap/dup
  });

  it('exactly 25 stops fits a single request', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => directionsResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);

    const cum = await estimateStopTravelByRoad(stopsAt(25));
    expect(cum).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('26 stops needs a second request and still stitches contiguously', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => directionsResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);

    const cum = await estimateStopTravelByRoad(stopsAt(26));
    expect(cum).toHaveLength(26);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 26; i++) expect(cum![i]).toBe((i * (i + 1)) / 2);
  });

  it('cumulative output is monotonic non-decreasing', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => directionsResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);

    const cum = await estimateStopTravelByRoad(stopsAt(40));
    expect(cum).not.toBeNull();
    for (let i = 1; i < cum!.length; i++) expect(cum![i]).toBeGreaterThanOrEqual(cum![i - 1]);
  });

  it('returns null on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}) }) as unknown as Response));
    expect(await estimateStopTravelByRoad(stopsAt(5))).toBeNull();
  });

  it('returns null when fetch throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await estimateStopTravelByRoad(stopsAt(5))).toBeNull();
  });

  it('returns null on a non-Ok Directions code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 'NoRoute', routes: [] }) }) as unknown as Response));
    expect(await estimateStopTravelByRoad(stopsAt(5))).toBeNull();
  });

  it('returns null if any later chunk fails (no partial cumulative)', async () => {
    // First chunk ok, second chunk HTTP-errors → whole estimate must be null.
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      call += 1;
      if (call === 1) return directionsResponse(String(url));
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }));
    expect(await estimateStopTravelByRoad(stopsAt(30))).toBeNull();
  });

  it('returns null when the leg count does not match the waypoints (malformed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{ legs: [{ duration: 1 }] }] }) }) as unknown as Response));
    // 5 stops should yield 4 legs; the mock returns 1 → reject.
    expect(await estimateStopTravelByRoad(stopsAt(5))).toBeNull();
  });

  it('guards fewer than 2 stops without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await estimateStopTravelByRoad([])).toEqual([]);
    expect(await estimateStopTravelByRoad([[0, 0]])).toEqual([0]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('layoutStopTimes', () => {
  const start = 8 * 3600; // 08:00:00

  it('first stop departs at start with no dwell; intermediate stops dwell; last has none', () => {
    const out = layoutStopTimes([0, 120, 180], { startSec: start, dwellSec: 18, speedFactor: 1 });
    expect(out[0]).toEqual({ arrivalSec: start, departureSec: start });
    // stop 1: +120s travel, then 18s dwell
    expect(out[1]).toEqual({ arrivalSec: start + 120, departureSec: start + 138 });
    // stop 2 (last): +60s travel from stop 1's departure, no trailing dwell
    expect(out[2]).toEqual({ arrivalSec: start + 198, departureSec: start + 198 });
  });

  it('scales travel by the speed factor (dwell is unaffected)', () => {
    const out = layoutStopTimes([0, 120, 180], { startSec: start, dwellSec: 18, speedFactor: 1.5 });
    expect(out[1].arrivalSec).toBe(start + 180);          // 120 * 1.5
    expect(out[1].departureSec).toBe(start + 180 + 18);   // + dwell
    expect(out[2].arrivalSec).toBe(start + 180 + 18 + 90); // 60 * 1.5 from departure
  });

  it('handles stops running opposite the shape (decreasing cumulative)', () => {
    // Stops sequenced against the shape's drawn direction → cumulative runs
    // high→low. Travel must still be real, not collapse to zero.
    const out = layoutStopTimes([180, 120, 0], { startSec: start, dwellSec: 18, speedFactor: 1 });
    expect(out[1]).toEqual({ arrivalSec: start + 60, departureSec: start + 78 });
    expect(out[2]).toEqual({ arrivalSec: start + 78 + 120, departureSec: start + 78 + 120 });
  });
});
