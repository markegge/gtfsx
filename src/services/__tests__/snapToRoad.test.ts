/**
 * Unit tests for src/services/snapToRoad.ts — mocked fetch.
 *
 * Catches code-side regressions: token missing from URL, chunking math wrong,
 * duplicate seam point not deduped, missing graceful-fallback on API error.
 * Real Mapbox contract drift is checked separately by the daily external-API
 * workflow.
 *
 * MAPBOX_TOKEN is captured at module load in snapToRoad.ts, so each test
 * stubs the env and dynamically imports the module fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockFetchOk(geometry: [number, number][]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        code: 'Ok',
        matchings: [{ geometry: { type: 'LineString', coordinates: geometry } }],
      }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('snapToRoad', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns input unchanged when fewer than 2 coordinates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { snapToRoad } = await import('../snapToRoad');

    expect(await snapToRoad([])).toEqual([]);
    expect(await snapToRoad([[1, 2]])).toEqual([[1, 2]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls Mapbox Map Matching with the access token and driving profile', async () => {
    const fetchMock = mockFetchOk([[1, 2], [3, 4]]);
    const { snapToRoad } = await import('../snapToRoad');

    await snapToRoad([[1, 2], [3, 4]]);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('api.mapbox.com/matching/v5/mapbox/driving/');
    expect(url).toContain('access_token=pk.test-token');
    expect(url).toContain('geometries=geojson');
    expect(url).toContain('1,2;3,4');
  });

  it('returns Mapbox-matched geometry on success', async () => {
    mockFetchOk([[10, 20], [30, 40]]);
    const { snapToRoad } = await import('../snapToRoad');

    const result = await snapToRoad([[1, 2], [3, 4]]);
    expect(result).toEqual([[10, 20], [30, 40]]);
  });

  it('returns original coordinates when API call fails (graceful fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );
    const { snapToRoad } = await import('../snapToRoad');

    const input: [number, number][] = [[1, 2], [3, 4]];
    const result = await snapToRoad(input);
    expect(result).toEqual(input);
  });

  it('returns original coordinates when Mapbox returns code != "Ok"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ code: 'NoMatch', matchings: [] }),
      }),
    );
    const { snapToRoad } = await import('../snapToRoad');

    const input: [number, number][] = [[1, 2], [3, 4]];
    expect(await snapToRoad(input)).toEqual(input);
  });

  it('returns original coordinates when fetch itself throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    const { snapToRoad } = await import('../snapToRoad');

    const input: [number, number][] = [[1, 2], [3, 4]];
    expect(await snapToRoad(input)).toEqual(input);
  });

  it('splits >100-coord inputs into chunks and merges without duplicating overlap point', async () => {
    // Each chunk returns an array of length matching the request size, with
    // distinct values so we can verify the seam dedupe.
    const chunkAResult: [number, number][] = Array.from({ length: 100 }, (_, i) => [i, i]);
    // Chunk B starts at the overlap seam (the last point of A) — snapToRoad
    // should drop its first point when merging.
    const chunkBResult: [number, number][] = Array.from({ length: 51 }, (_, i) => [99 + i, 99 + i]);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 'Ok', matchings: [{ geometry: { type: 'LineString', coordinates: chunkAResult } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 'Ok', matchings: [{ geometry: { type: 'LineString', coordinates: chunkBResult } }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { snapToRoad } = await import('../snapToRoad');
    const input: [number, number][] = Array.from({ length: 150 }, (_, i) => [i, i]);
    const result = await snapToRoad(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 100 + 51 chunks, minus 1 deduped seam point = 150.
    expect(result.length).toBe(150);
    // First and last preserved.
    expect(result[0]).toEqual([0, 0]);
    expect(result[result.length - 1]).toEqual([149, 149]);
  });
});
