// Unit tests for the delete-protection API client additions (issue #63):
//   - deleteProject sends the ?unpublish=1 flag when asked, and surfaces the
//     server's 409 message when a feed can't be deleted (published/locked);
//   - listDeletedProjects lists the trash, scoped like listProjects; and
//   - restoreProject un-deletes a feed, possibly under a different slug.
//
// fetch is fully stubbed (same convention as myFeedsImport.test.ts) — server
// behavior itself is covered by the worker tests.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteProject, listDeletedProjects, restoreProject } from '../projectsApi';
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

describe('deleteProject', () => {
  it('sends a plain DELETE with no query string by default', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteProject('p1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/projects/p1');
    expect(init?.method).toBe('DELETE');
  });

  it('appends ?unpublish=1 for the combined unpublish-and-delete action', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteProject('p1', { unpublish: true });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/projects/p1?unpublish=1');
  });

  it('rejects with the server message and 409 status when the feed is published', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        {
          error: 'published',
          message:
            'This feed is published at feeds.gtfsx.com/downtown. Unpublish it before deleting.',
        },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteProject('p1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Unpublish it before deleting'),
    });
  });
});

describe('listDeletedProjects', () => {
  it('lists the trash for the personal workspace with no scope param', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        projects: [
          {
            id: 'd1',
            slug: 'old-feed',
            name: 'Old Feed',
            description: null,
            ownerType: 'user',
            ownerId: 'u1',
            workingStateVersion: 1,
            workingStateSize: null,
            workingStateUpdatedAt: null,
            archivedAt: null,
            createdAt: 1,
            updatedAt: 2,
            locked: false,
            deletedAt: 5000,
            purgeAt: 5000 + 30 * 24 * 60 * 60 * 1000,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await listDeletedProjects();

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects/deleted');
    expect(calledUrl).not.toContain('scope=');
    expect(res.projects).toHaveLength(1);
    expect(res.projects[0].deletedAt).toBe(5000);
  });

  it('forwards the org scope, mirroring listProjects', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ projects: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await listDeletedProjects({ scope: 'org:ORG1' });

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/projects/deleted');
    expect(calledUrl).toContain('scope=org%3AORG1');
  });
});

describe('restoreProject', () => {
  it('POSTs to the restore route and returns the restored project', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'd1',
        slug: 'old-feed',
        name: 'Old Feed',
        description: null,
        ownerType: 'user',
        ownerId: 'u1',
        workingStateVersion: 1,
        workingStateSize: null,
        workingStateUpdatedAt: null,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 2,
        locked: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreProject('d1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/projects/d1/restore');
    expect(init?.method).toBe('POST');
    expect(restored.slug).toBe('old-feed');
  });

  it('can come back under a different slug (the old one was claimed while deleted)', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        id: 'd1',
        slug: 'old-feed-2',
        name: 'Old Feed',
        description: null,
        ownerType: 'user',
        ownerId: 'u1',
        workingStateVersion: 1,
        workingStateSize: null,
        workingStateUpdatedAt: null,
        archivedAt: null,
        createdAt: 1,
        updatedAt: 2,
        locked: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreProject('d1');
    expect(restored.slug).toBe('old-feed-2');
  });

  it('propagates a restore failure as an ApiError', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: 'not_found', message: 'Feed not found' }, 404),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(restoreProject('missing')).rejects.toBeInstanceOf(ApiError);
  });
});
