// Shared publish core, reused by the interactive publish route
// (worker/projects/routes.ts) and the scheduled-publish cron
// (worker/cron/tasks.ts). Given an already-resolved project + snapshot and the
// caller's chosen flags, it runs the ID-stability check, copies the rendered
// ZIP into the publication slot, flips the `publication` pointer, appends
// history + audit, and kicks off the background catalog + thumbnail work.
//
// Callers own access/quota gating (requirePublishAccess) and body parsing — this
// function performs the publish itself, identically for both paths.
import { ulid } from 'ulidx';
import type { Env } from '../env';
import { assertIdStable } from './idStability';
import { submitToCatalogs } from './submit';
import { stopBoundingBox, deriveCatalogFeatures, type CatalogMeta } from './catalog';
import { getFeedBlob, publicationZipKey, putFeedBlob } from '../projects/r2';
import { loadFeedStateFromKey, maybeRegenerateThumbnail } from '../embeds/thumbnail';
import { logAudit } from '../util/audit';
import { validationFailed, notFound } from '../util/errors';

export interface PublishProject {
  id: string;
  slug: string;
  name: string;
}
export interface PublishSnapshot {
  id: string;
  state_r2_key: string;
  zip_r2_key: string | null;
  validation_errors: number;
  validation_warnings: number;
}

export interface PerformPublishInput {
  project: PublishProject;
  snapshot: PublishSnapshot;
  /** Currently-published row for the project (null if first publish). */
  existingPublication: { snapshot_id: string } | null;
  ignoreWarnings?: boolean;
  ignoreRtBreakage?: boolean;
  /** Acknowledges the agency_id-churn warning (C2). */
  ignoreAgencyChurn?: boolean;
  /**
   * SPDX license identifier to record on `feed_project` as part of this
   * publish. `undefined` leaves the stored value untouched (the cron path never
   * supplies it); `null` clears it.
   *
   * There is no NTD ID here: it lives on the agency, inside the feed
   * (agency.external_id), so it arrives with the snapshot state and is read
   * per-agency by the feeds origin.
   */
  licenseSpdx?: string | null;
  /** Null for system/cron-initiated publishes. */
  actorUserId: string | null;
  /** Interactive multipart path supplies the freshly-rendered ZIP; the cron
   *  omits it so we copy the snapshot's stored zip_r2_key. */
  incomingZip?: ArrayBuffer | null;
  feedsOrigin: string;
  /** Defer catalog + thumbnail work. Route passes c.executionCtx.waitUntil;
   *  the cron passes a function that awaits inline (latency doesn't matter). */
  runBackground: (p: Promise<unknown>) => void;
  ip?: string | null;
  now?: number;
}

export interface PerformPublishResult {
  publishedBytes: number;
  canonicalUrl: string;
  wasRollback: boolean;
}

export async function performPublish(env: Env, input: PerformPublishInput): Promise<PerformPublishResult> {
  const { project, snapshot, existingPublication, actorUserId, incomingZip, feedsOrigin, runBackground } = input;
  const ignoreWarnings = input.ignoreWarnings ?? false;
  const ignoreRtBreakage = input.ignoreRtBreakage ?? false;
  const ignoreAgencyChurn = input.ignoreAgencyChurn ?? false;
  const now = input.now ?? Date.now();

  // Validation gate: errors block publish unless ignoreWarnings=true.
  if (snapshot.validation_errors > 0 && !ignoreWarnings) {
    throw validationFailed('Feed has validation errors. Fix them or pass ignoreWarnings=true to publish anyway.', {
      validationErrors: snapshot.validation_errors,
      validationWarnings: snapshot.validation_warnings,
    });
  }

  // ─── ID-stability gates (rt_breakage BE-88 + agency_id_churn C2) ────────────
  //
  // One shared evaluation (worker/publication/idStability.ts → assertIdStable),
  // also run by the schedule endpoint at SCHEDULE time so a scheduled publish is
  // acknowledged while the user is still at the keyboard. The cron replays those
  // persisted acknowledgements through here — so a gate that fires at fire time
  // means the diff CHANGED since scheduling (someone published something else in
  // between, moving the baseline), and the schedule correctly fails.
  await assertIdStable(env, {
    projectId: project.id,
    snapshot,
    existingPublication,
    ignoreRtBreakage,
    ignoreAgencyChurn,
  });

  // Copy the rendered ZIP into the publication slot in R2.
  const pubKey = publicationZipKey(project.id, snapshot.id);
  let publishedBytes: number;
  if (incomingZip) {
    await putFeedBlob(env, pubKey, incomingZip, { contentType: 'application/zip' });
    publishedBytes = incomingZip.byteLength;
  } else {
    if (!snapshot.zip_r2_key) {
      throw validationFailed('This snapshot has no rendered ZIP. Publish with multipart form instead.');
    }
    const source = await getFeedBlob(env, snapshot.zip_r2_key);
    if (!source) throw notFound('Rendered ZIP missing from storage');
    const buf = await source.arrayBuffer();
    publishedBytes = buf.byteLength;
    await putFeedBlob(env, pubKey, buf, { contentType: 'application/zip' });
  }

  // Record the feed's license on feed_project (migration 0024) — the copy the
  // public feeds origin serves in feed_info.json + dmfr.json. Only written when
  // the caller supplied it: the cron path omits it and must not clobber what the
  // last interactive publish set.
  if (input.licenseSpdx !== undefined) {
    await env.DB.prepare(`UPDATE feed_project SET license_spdx = ? WHERE id = ?`)
      .bind(input.licenseSpdx, project.id)
      .run();
  }

  // Upsert publication + append history.
  const wasRollback = !!existingPublication && existingPublication.snapshot_id !== snapshot.id;
  await env.DB.prepare(
    `INSERT INTO publication (project_id, snapshot_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       snapshot_id = excluded.snapshot_id,
       published_by_user_id = excluded.published_by_user_id,
       published_at = excluded.published_at,
       canonical_slug = excluded.canonical_slug,
       zip_r2_key = excluded.zip_r2_key`,
  )
    .bind(project.id, snapshot.id, actorUserId, now, project.slug, pubKey)
    .run();

  await env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, snapshot_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'publish', ?, ?)`,
  )
    .bind(ulid(), project.id, snapshot.id, actorUserId, now)
    .run();

  await logAudit(env, {
    actorUserId,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.publish',
    metadata: { snapshotId: snapshot.id, size: publishedBytes, rollback: wasRollback },
    ip: input.ip ?? null,
  });

  // Auto-submit to opted-in catalogs (BE-80/83) + refresh the thumbnail. Both
  // off the response path; neither breaks publish.
  runBackground(
    submitToCatalogs(env, {
      projectId: project.id,
      slug: project.slug,
      feedsOrigin,
      feedTitle: project.name,
    }).catch((err) => {
      console.error('[publish] catalog submission error', err);
    }),
  );
  runBackground(
    (async () => {
      const state = await loadFeedStateFromKey(env, snapshot.state_r2_key);
      if (state) await maybeRegenerateThumbnail(env, project.id, state);
    })().catch((err) => console.error('[thumbnail] publish-trigger error', err)),
  );

  // Persist the per-feed catalog metadata (bbox, features, feed_publisher_name,
  // feed_contact_email) that feeds.<zone>/catalog.json needs, computed ONCE
  // here from the snapshot state so the catalog route reads D1 only and never
  // loads N feed blobs per request (issue #47). Off the response path; failure
  // never breaks publish — the catalog just omits the fields it couldn't fill.
  runBackground(
    computeAndStoreCatalogMeta(env, project.id, snapshot.state_r2_key).catch((err) =>
      console.error('[publish] catalog-meta error', err),
    ),
  );

  const canonicalUrl = `${feedsOrigin.replace(/\/$/, '')}/${project.slug}/gtfs.zip`;
  return { publishedBytes, canonicalUrl, wasRollback };
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

/**
 * Compute the catalog metadata for a just-published feed from its snapshot
 * state and store it on the publication row (publication.catalog_meta_json).
 * Best-effort: a missing or unreadable state leaves the column untouched (the
 * catalog route degrades gracefully). Loads the state blob independently of the
 * thumbnail task so it stays fully decoupled from that path.
 */
async function computeAndStoreCatalogMeta(env: Env, projectId: string, stateKey: string): Promise<void> {
  const blob = await getFeedBlob(env, stateKey);
  if (!blob) return;
  let raw: unknown;
  try {
    const text = await new Response(blob.body.pipeThrough(new DecompressionStream('gzip'))).text();
    raw = JSON.parse(text);
  } catch {
    return; // unreadable state — leave catalog_meta_json as-is
  }
  const state = raw as {
    stops?: Array<{ stop_lat?: unknown; stop_lon?: unknown }>;
    feedInfo?: { feed_publisher_name?: unknown; feed_contact_email?: unknown } | null;
  };
  const feedInfo = state.feedInfo ?? null;
  const meta: CatalogMeta = {
    bbox: stopBoundingBox(state.stops),
    features: deriveCatalogFeatures(raw),
    feedPublisherName: strOrNull(feedInfo?.feed_publisher_name),
    feedContactEmail: strOrNull(feedInfo?.feed_contact_email),
  };
  await env.DB.prepare(`UPDATE publication SET catalog_meta_json = ? WHERE project_id = ?`)
    .bind(JSON.stringify(meta), projectId)
    .run();
}
