// Unit tests for the importer's "My feeds" source service:
//   - resolving a (published) feed to its canonical GTFS zip URL, and
//   - listing the user's feeds for a workspace scope (org-scoped) with the
//     published/unpublished mapping the picker relies on.
//
// fetch is fully stubbed, so the org-scoping assertion verifies the client
// forwards the workspace scope to the server (server-side scoping is covered by
// the worker tests).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listMyFeeds, publishedFeedGtfsUrl, toMyFeedItem } from '../myFeedsImport';
import type { ProjectSummary } from '../projectsApi';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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

describe('publishedFeedGtfsUrl', () => {
  it('builds the canonical published zip URL', () => {
    expect(publishedFeedGtfsUrl('my-slug')).toBe('https://feeds.gtfsx.com/my-slug/gtfs.zip');
  });
});

describe('toMyFeedItem', () => {
  it('resolves a published feed to its GTFS URL', () => {
    const item = toMyFeedItem(project({ slug: 'pub', published: true }));
    expect(item.published).toBe(true);
    expect(item.gtfsUrl).toBe('https://feeds.gtfsx.com/pub/gtfs.zip');
  });

  it('leaves an unpublished feed without a GTFS URL', () => {
    const item = toMyFeedItem(project({ slug: 'draft', published: false }));
    expect(item.published).toBe(false);
    expect(item.gtfsUrl).toBeNull();
  });
});

describe('listMyFeeds', () => {
  it('requests the org scope and maps only that workspace’s feeds', async () => {
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

    expect(feeds.map((f) => f.id)).toEqual(['o1', 'o2']);
    expect(feeds[0].gtfsUrl).toBe('https://feeds.gtfsx.com/org-pub/gtfs.zip');
    expect(feeds[1].gtfsUrl).toBeNull();
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
