// Delete-protection helpers for issue #63 (protect feeds from accidental
// deletion). Pure/presentational logic factored out of MyFeedsPage so it's
// unit-testable without rendering: the published-feed warning copy, the
// purge-countdown label for the Recently-deleted list, and the
// slug-changed-on-restore notice (mirrors MoveFeedDialog's existing
// slug-collision notice for the same "server picked a different slug" case).
import type { ProjectSummary } from './projectsApi';

/** Strip the protocol off a feeds origin, e.g. "https://feeds.gtfsx.com" ->
 * "feeds.gtfsx.com", for copy that reads as a plain address. */
export function feedsOriginHost(feedsOrigin: string): string {
  return feedsOrigin.replace(/^https?:\/\//, '');
}

/**
 * The delete-flow routing decision (issue #63): a published feed must never
 * get the plain "delete feed?" confirm — it goes to the distinct
 * unpublish-and-delete dialog instead. Pulled out as its own function so the
 * decision is unit-testable independent of the dialog components themselves.
 */
export function requiresUnpublishBeforeDelete(project: Pick<ProjectSummary, 'published'>): boolean {
  return project.published === true;
}

/**
 * Copy for the proactive published-delete dialog: shown when the client
 * already knows (ProjectSummary.published) that the feed is live, before even
 * attempting the delete. The defensive path (a 409 from a race with another
 * tab) shows the server's own message instead of this.
 */
export function publishedDeleteMessage(project: ProjectSummary, feedsOrigin: string): string {
  return (
    `"${project.name}" is published at ${feedsOriginHost(feedsOrigin)}/${project.slug}. ` +
    `Transit apps and riders may be pulling from it right now, so it needs to be ` +
    `unpublished before it can be deleted.`
  );
}

/** "purged in N days" copy for a Recently-deleted row, from the server's
 * computed purgeAt (epoch ms). */
export function formatPurgeCountdown(purgeAt: number, now: number = Date.now()): string {
  const days = Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'purging soon';
  if (days === 1) return 'purged in 1 day';
  return `purged in ${days} days`;
}

/**
 * Restore can come back with a different slug than the feed had before it was
 * deleted (a new feed claimed the old slug while it sat in the trash, so the
 * server assigned a free suffixed one). Returns the notice to show, or null
 * when the slug is unchanged (no notice needed).
 */
export function restoreSlugChangeMessage(
  previousSlug: string,
  restored: ProjectSummary,
): string | null {
  if (restored.slug === previousSlug) return null;
  return `Restored "${restored.name}" as "${restored.slug}" (the address "${previousSlug}" was taken while it was deleted).`;
}
