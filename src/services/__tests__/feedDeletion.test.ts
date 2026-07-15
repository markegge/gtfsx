// Unit tests for the delete-protection pure helpers (issue #63): the
// proactive published-delete warning copy, the trash-row purge countdown, and
// the slug-changed-on-restore notice. These are exercised directly (no
// rendering) — see projectsApiDeletion.test.ts for the network-facing half
// (deleteProject/restoreProject/listDeletedProjects request shaping).
import { describe, expect, it } from 'vitest';
import {
  feedsOriginHost,
  formatPurgeCountdown,
  publishedDeleteMessage,
  requiresUnpublishBeforeDelete,
  restoreSlugChangeMessage,
} from '../feedDeletion';
import type { ProjectSummary } from '../projectsApi';

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

describe('requiresUnpublishBeforeDelete', () => {
  it('routes a published feed to the unpublish-and-delete flow, not a plain delete', () => {
    expect(requiresUnpublishBeforeDelete(project({ published: true }))).toBe(true);
  });

  it('lets an unpublished (or never-published) feed use the plain confirm delete', () => {
    expect(requiresUnpublishBeforeDelete(project({ published: false }))).toBe(false);
    expect(requiresUnpublishBeforeDelete(project({ published: undefined }))).toBe(false);
  });
});

describe('feedsOriginHost', () => {
  it('strips the protocol', () => {
    expect(feedsOriginHost('https://feeds.gtfsx.com')).toBe('feeds.gtfsx.com');
    expect(feedsOriginHost('https://staging-feeds.gtfsx.com')).toBe('staging-feeds.gtfsx.com');
  });
});

describe('publishedDeleteMessage', () => {
  it('names the feed and its live URL, and says it must be unpublished first', () => {
    const msg = publishedDeleteMessage(
      project({ name: 'Downtown Shuttle', slug: 'downtown' }),
      'https://feeds.gtfsx.com',
    );
    expect(msg).toContain('Downtown Shuttle');
    expect(msg).toContain('feeds.gtfsx.com/downtown');
    expect(msg.toLowerCase()).toContain('unpublished');
    // Public-facing copy rule: no spaced em dash.
    expect(msg).not.toContain(' — ');
  });
});

describe('formatPurgeCountdown', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_000_000_000_000;

  it('pluralizes multi-day countdowns', () => {
    expect(formatPurgeCountdown(now + 12 * DAY, now)).toBe('purged in 12 days');
  });

  it('singularizes exactly one day', () => {
    expect(formatPurgeCountdown(now + DAY, now)).toBe('purged in 1 day');
  });

  it('rounds a partial day up (still purges within that day)', () => {
    expect(formatPurgeCountdown(now + DAY + 1, now)).toBe('purged in 2 days');
  });

  it('treats a past or imminent purgeAt as "purging soon" rather than a negative count', () => {
    expect(formatPurgeCountdown(now - DAY, now)).toBe('purging soon');
    expect(formatPurgeCountdown(now, now)).toBe('purging soon');
  });
});

describe('restoreSlugChangeMessage', () => {
  it('returns null when the slug is unchanged', () => {
    const restored = project({ slug: 'downtown' });
    expect(restoreSlugChangeMessage('downtown', restored)).toBeNull();
  });

  it('names both the old and new slug when the server assigned a different one', () => {
    const restored = project({ name: 'Downtown Shuttle', slug: 'downtown-2' });
    const msg = restoreSlugChangeMessage('downtown', restored);
    expect(msg).toContain('Downtown Shuttle');
    expect(msg).toContain('downtown-2');
    expect(msg).toContain('downtown');
    expect(msg).not.toContain(' — ');
  });
});
