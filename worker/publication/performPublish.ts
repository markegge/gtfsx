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
import { diffRemovedIds, isEmpty as rtReportEmpty, type RtBreakageReport } from './idStability';
import { submitToCatalogs } from './submit';
import { getFeedBlob, publicationZipKey, putFeedBlob } from '../projects/r2';
import { loadFeedStateFromKey, maybeRegenerateThumbnail } from '../embeds/thumbnail';
import { logAudit } from '../util/audit';
import { validationFailed, notFound, rtBreakage, agencyIdChurn } from '../util/errors';

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
   * NTD ID / SPDX license to project onto `feed_project` as part of this
   * publish. `undefined` leaves the existing projection untouched (the cron
   * path never supplies them); `null` clears it.
   *
   * ntdId is a STRING — NTD IDs carry significant leading zeros ("00123").
   */
  ntdId?: string | null;
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

  // ─── ID-stability gates ─────────────────────────────────────────────────────
  //
  // Both gates read the SAME diff (old published state − new snapshot state),
  // so we load and diff at most once per publish:
  //
  //   1. rt_breakage (BE-88) — the harder gate, and therefore checked first.
  //      Only applies when the project has externally-hosted (managed=0) RT
  //      feeds: dropping an agency/route/stop/trip id out from under someone
  //      else's RT producer breaks it. Any removed id trips it.
  //
  //   2. agency_id_churn (C2) — applies to EVERY project, RT or not. FTA's
  //      enhanced P-50 form crosswalks a published feed to its NTD ID by
  //      agency_id, so removing/renaming an agency_id quietly breaks the NTD
  //      crosswalk (and any consumer keyed on agency_id). Only the `agencies`
  //      slice of the diff matters here.
  //
  // Both are advisory: the caller acknowledges and re-publishes with the
  // matching ignore flag. Both are skipped on a first publish and on a
  // re-publish of the already-published snapshot (nothing can have changed).
  const snapshotChanged = !!existingPublication && existingPublication.snapshot_id !== snapshot.id;
  if (existingPublication && snapshotChanged && (!ignoreRtBreakage || !ignoreAgencyChurn)) {
    const rtCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_rt_feed WHERE project_id = ? AND managed = 0`,
    )
      .bind(project.id)
      .first<{ n: number }>();
    const rtGateApplies = (rtCount?.n ?? 0) > 0 && !ignoreRtBreakage;
    const churnGateApplies = !ignoreAgencyChurn;

    if (rtGateApplies || churnGateApplies) {
      const prior = await env.DB.prepare(
        `SELECT state_r2_key FROM feed_snapshot WHERE id = ? AND project_id = ?`,
      )
        .bind(existingPublication.snapshot_id, project.id)
        .first<{ state_r2_key: string }>();
      if (prior) {
        const removed: RtBreakageReport = await diffRemovedIds(
          env,
          prior.state_r2_key,
          snapshot.state_r2_key,
        );
        if (rtGateApplies && !rtReportEmpty(removed)) {
          throw rtBreakage({
            removed: {
              agencies: removed.agencies,
              routes: removed.routes,
              stops: removed.stops,
              trips: removed.trips,
            },
          });
        }
        if (churnGateApplies && removed.agencies.length > 0) {
          throw agencyIdChurn({ removed: { agencies: removed.agencies } });
        }
      }
    }
  }

  // Copy the rendered ZIP into the publication slot in R2.
  const pubKey = publicationZipKey(project.id, snapshot.id);
  let publishedBytes = 0;
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

  // Project the NTD ID + license onto feed_project (migration 0024). The
  // editor's feed state stays the source of truth; this is the copy the public
  // feeds origin reads for feed_info.json + dmfr.json without having to inflate
  // the state blob. Only written when the caller supplied the field — the cron
  // path omits both and must not clobber what the last interactive publish set.
  const sets: string[] = [];
  const binds: (string | null)[] = [];
  if (input.ntdId !== undefined) {
    sets.push('ntd_id = ?');
    binds.push(input.ntdId); // string | null — never Number()
  }
  if (input.licenseSpdx !== undefined) {
    sets.push('license_spdx = ?');
    binds.push(input.licenseSpdx);
  }
  if (sets.length > 0) {
    await env.DB.prepare(`UPDATE feed_project SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds, project.id)
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

  const canonicalUrl = `${feedsOrigin.replace(/\/$/, '')}/${project.slug}/gtfs.zip`;
  return { publishedBytes, canonicalUrl, wasRollback };
}
