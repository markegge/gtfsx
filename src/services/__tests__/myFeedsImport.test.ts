// Unit tests for the importer's "My feeds" source service (v2):
//   - listing the user's feeds for a workspace scope (org-scoped), now
//     including UNPUBLISHED feeds — every feed is importable;
//   - reshaping a project's working-state snapshot into the transient
//     ImportData the picker consumes (workingStateToImportData); and
//   - resolving a feed (published or draft) via its working state without
//     touching the editor store (no clobbering the open project).
//
// fetch is fully stubbed, so the org-scoping assertion verifies the client
// forwards the workspace scope to the server (server-side scoping is covered by
// the worker tests).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listMyFeeds,
  resolveMyFeedImportData,
  toMyFeedItem,
  workingStateToImportData,
} from '../myFeedsImport';
import type { ProjectSummary } from '../projectsApi';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A 200 working-state response: raw JSON text body + the version header the
 * client reads (mirrors GET /api/projects/:id/working-state). */
function workingStateResponse(snapshot: unknown, version = 3): Response {
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json', 'X-Working-State-Version': String(version) },
  });
}

function project(partial: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: 'p1',
    slug: 'feed-1',
    name: 'Feed 1',
    description: null,
    ownerType: 'user',
    ownerId: 'u1',
    workingStateVersion: 1,
    workingStateSize: null,
    workingStateUpdatedAt: 1000,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
    locked: false,
    ...partial,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toMyFeedItem', () => {
  it('labels a published feed as published', () => {
    const item = toMyFeedItem(project({ slug: 'pub', published: true }));
    expect(item.published).toBe(true);
  });

  it('labels an unpublished feed as draft but still produces an item', () => {
    const item = toMyFeedItem(project({ slug: 'draft', published: false }));
    expect(item.published).toBe(false);
    expect(item.id).toBe('p1');
    expect(item.slug).toBe('draft');
  });

  it('prefers the working-state timestamp for updatedAt', () => {
    const item = toMyFeedItem(project({ workingStateUpdatedAt: 9999, updatedAt: 2 }));
    expect(item.updatedAt).toBe(9999);
  });
});

describe('listMyFeeds', () => {
  it('requests the org scope and lists both published AND draft feeds', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        projects: [
          project({ id: 'o1', slug: 'org-pub', name: 'Org Pub', ownerType: 'org', ownerId: 'ORG1', published: true }),
          project({ id: 'o2', slug: 'org-draft', name: 'Org Draft', ownerType: 'org', ownerId: 'ORG1', published: false }),
        ],
        quota: { projects: { used: 2, limit: 99 }, warning: null },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const feeds = await listMyFeeds('org:ORG1');

    // The workspace scope is forwarded so the server returns only this org's feeds.
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects');
    expect(calledUrl).toContain('scope=org%3AORG1');

    // Both the published and the draft feed are listed (v2 drops the
    // published-only restriction).
    expect(feeds.map((f) => f.id)).toEqual(['o1', 'o2']);
    expect(feeds.map((f) => f.published)).toEqual([true, false]);
  });

  it('omits the scope param for personal feeds', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ projects: [], quota: { projects: { used: 0, limit: 3 }, warning: null } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listMyFeeds('personal');

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects');
    expect(calledUrl).not.toContain('scope=');
  });
});

describe('workingStateToImportData', () => {
  it('maps working-state entity slices into ImportData', () => {
    const data = workingStateToImportData({
      routes: [{ route_id: 'R1', route_short_name: '1' }],
      stops: [{ stop_id: 'S1', stop_name: 'Main', stop_lat: 1, stop_lon: 2 }],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK' }],
      stopTimes: [{ trip_id: 'T1', stop_id: 'S1', stop_sequence: 1 }],
    });
    expect(data.routes.map((r) => r.route_id)).toEqual(['R1']);
    expect(data.stops).toHaveLength(1);
    expect(data.trips).toHaveLength(1);
    expect(data.stopTimes).toHaveLength(1);
  });

  it('defaults missing keys to empty arrays and warnings to []', () => {
    const data = workingStateToImportData({ routes: [{ route_id: 'A' }] });
    expect(data.routes).toHaveLength(1);
    expect(data.stops).toEqual([]);
    expect(data.fareProducts).toEqual([]);
    expect(data.agencies).toEqual([]);
    expect(data.warnings).toEqual([]);
    expect(data.feedInfo).toBeNull();
  });

  it('treats a non-array slice value as empty (a corrupt/old blob)', () => {
    const data = workingStateToImportData({ routes: 'nope' as unknown });
    expect(data.routes).toEqual([]);
  });

  it('backfills route-stop shape_id from trips (legacy single-shape feeds)', () => {
    const data = workingStateToImportData({
      routes: [{ route_id: 'R1' }],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK', shape_id: 'SH1', direction_id: 0 }],
      routeStops: [{ route_id: 'R1', stop_id: 'S1', direction_id: 0, sequence: 0 }],
    });
    // The legacy route stop had no shape_id; it inherits the direction's shape.
    expect(data.routeStops[0].shape_id).toBe('SH1');
  });
});

describe('resolveMyFeedImportData', () => {
  it('resolves an unpublished project via its working state', async () => {
    const snapshot = {
      routes: [{ route_id: 'R1', route_short_name: '1' }],
      stops: [{ stop_id: 'S1', stop_name: 'Main', stop_lat: 1, stop_lon: 2 }],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK' }],
      stopTimes: [{ trip_id: 'T1', stop_id: 'S1', stop_sequence: 1 }],
    };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      workingStateResponse(snapshot, 5),
    );
    vi.stubGlobal('fetch', fetchMock);

    const data = await resolveMyFeedImportData('p-draft');

    // Hits the org-scoped working-state route (server enforces access).
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects/p-draft/working-state');
    expect(data.routes.map((r) => r.route_id)).toEqual(['R1']);
    expect(data.stops).toHaveLength(1);
  });

  it('does NOT mutate the editor store (the open project is untouched)', async () => {
    const { useStore } = await import('../../store');
    useStore.getState().setRoutes([{ route_id: 'CURRENT' } as never]);

    const fetchMock = vi.fn(async () => workingStateResponse({ routes: [{ route_id: 'OTHER' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await resolveMyFeedImportData('p-other');

    // We parsed the OTHER project's data into a transient structure...
    expect(data.routes.map((r) => r.route_id)).toEqual(['OTHER']);
    // ...but the currently-open project's routes are unchanged (no clobber).
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['CURRENT']);
  });
});
