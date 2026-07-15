// Regression test for the projectsApi error mapper dropping ApiError.extra on
// the generic (non-409-version-conflict) path. PublishPanel reads
// `err.extra?.removed` (rt_breakage / agency_id_churn) and `err.extra?.issues`
// (validation_failed) to render publish-blocker details, so the full parsed
// payload must survive as `extra` — matching apiClient's default mode.
//
// fetch is fully stubbed (same convention as projectsApiDeletion.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishProject } from '../projectsApi';
import { ApiError } from '../authApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('projectsApi error mapper — extra passthrough', () => {
  it('surfaces `removed` on a 409 rt_breakage (not a version conflict)', async () => {
    const removed = { stops: ['S1', 'S2'], routes: [], trips: [], agencies: [] };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        {
          error: 'rt_breakage',
          message: 'Publishing this version will break your GTFS-Realtime feed',
          removed,
        },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await publishProject('p1', { snapshotId: 's1' }).then(
      () => null,
      (e) => e as unknown,
    );

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('rt_breakage');
    expect(apiErr.status).toBe(409);
    // Regression guard: without the fix, extra is {} and this is undefined.
    expect(apiErr.extra?.removed).toEqual(removed);
  });

  it('surfaces `issues` on a 422 validation_failed', async () => {
    const issues = [{ message: 'stop_times.txt: missing arrival_time' }];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        {
          error: 'validation_failed',
          message: 'Feed has blocking validation errors',
          issues,
        },
        422,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await publishProject('p1', { snapshotId: 's1' }).then(
      () => null,
      (e) => e as unknown,
    );

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('validation_failed');
    expect(apiErr.status).toBe(422);
    expect(apiErr.extra?.issues).toEqual(issues);
  });
});
