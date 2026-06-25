// "My feeds" import source — lists the signed-in user's own / org feeds and
// resolves a selected one to its published GTFS so the existing ImportDialog
// route/stop picker + import pipeline can ingest it.
//
// v1 imports from the stable PUBLISHED feed (FEEDS_ORIGIN/<slug>/gtfs.zip).
// Importing the live unsaved editing draft is a deliberate follow-up (it would
// need a draft-export round-trip); only published feeds are offered here.

import { listProjects, type ProjectSummary } from './projectsApi';

/**
 * Env-aware public feeds origin. Mirrors the fallback used by PublishPanel /
 * EmbedPanel / orgsApi: VITE_FEEDS_ORIGIN overrides when set, otherwise pick
 * the staging vs prod host from the current SPA hostname. The host must match
 * the worker's FEEDS_ORIGIN so /api/import/fetch can short-circuit the
 * same-zone canonical URL and read the bytes straight from R2.
 */
export function feedsOrigin(): string {
  return (
    (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
    (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
      ? 'https://staging-feeds.gtfsx.com'
      : 'https://feeds.gtfsx.com')
  );
}

/** Canonical published GTFS zip URL for a feed slug. */
export function publishedFeedGtfsUrl(slug: string): string {
  return `${feedsOrigin().replace(/\/$/, '')}/${slug}/gtfs.zip`;
}

export interface MyFeedItem {
  id: string;
  slug: string;
  name: string;
  /** Has a live canonical publication — only published feeds are importable. */
  published: boolean;
  /** Canonical published GTFS URL; null when the feed isn't published yet. */
  gtfsUrl: string | null;
  /** Last-edited timestamp (working state, falling back to project updatedAt). */
  updatedAt: number;
  thumbnailUrl: string | null;
}

/** Shape a raw project summary into the importer's feed-list item. */
export function toMyFeedItem(p: ProjectSummary): MyFeedItem {
  const published = p.published === true;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    published,
    gtfsUrl: published ? publishedFeedGtfsUrl(p.slug) : null,
    updatedAt: p.workingStateUpdatedAt ?? p.updatedAt,
    thumbnailUrl: p.thumbnailUrl ?? null,
  };
}

/**
 * List the feeds in one workspace for the importer. `scope` is 'personal' or
 * 'org:<id>' (the same scope string MyFeedsPage derives from activeWorkspace),
 * so the server returns only feeds the caller can access — org-scoping is
 * enforced server-side. Archived feeds are excluded (importer default).
 */
export async function listMyFeeds(scope: string): Promise<MyFeedItem[]> {
  const res = await listProjects({ scope });
  return res.projects.map(toMyFeedItem);
}
