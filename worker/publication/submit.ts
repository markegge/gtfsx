// Catalog submission — pushes published feeds out to external aggregators.
// Called in the background from the publish handler via ctx.waitUntil.
//
// Each catalog row (project_catalog_submission) is independently retried on
// next publish; an 'error' status here is surfaced in the UI via
// GET /api/projects/:id/catalog-submissions so the user can re-opt-in.

import type { Env } from '../env';
import { getMobilityDbAccessToken } from '../distribution/mobility';

export interface SubmissionInput {
  projectId: string;
  slug: string;
  feedsOrigin: string;
  feedTitle: string;
}

export async function submitToCatalogs(env: Env, input: SubmissionInput): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT project_id, catalog, external_feed_id, status
       FROM project_catalog_submission
       WHERE project_id = ?`,
  )
    .bind(input.projectId)
    .all<{ project_id: string; catalog: string; external_feed_id: string | null; status: string }>();

  for (const row of rows.results ?? []) {
    if (row.status === 'error') continue;
    if (row.catalog === 'mobility_db') {
      await submitToMobilityDb(env, input, row.external_feed_id);
    } else if (row.catalog === 'transit_land') {
      await submitToTransitLand(env, input);
    }
  }
}

async function submitToMobilityDb(
  env: Env,
  input: SubmissionInput,
  externalFeedId: string | null,
): Promise<void> {
  const producerUrl = `${input.feedsOrigin.replace(/\/$/, '')}/${input.slug}/gtfs.zip`;
  try {
    const token = await getMobilityDbAccessToken(env);
    const body = {
      source_info: { producer_url: producerUrl },
      feed_name: input.feedTitle,
    };

    const isUpdate = Boolean(externalFeedId);
    const url = isUpdate
      ? `https://api.mobilitydatabase.org/v1/gtfs_feeds/${externalFeedId}`
      : 'https://api.mobilitydatabase.org/v1/gtfs_feeds';

    const r = await fetch(url, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 500);
      await env.DB.prepare(
        `UPDATE project_catalog_submission
            SET status = 'error', last_submitted_at = ?, last_error = ?
          WHERE project_id = ? AND catalog = 'mobility_db'`,
      )
        .bind(Date.now(), `HTTP ${r.status}: ${text}`, input.projectId)
        .run();
      return;
    }
    let assignedId: string | null = externalFeedId;
    try {
      const j = (await r.json()) as { id?: string; feed_id?: string };
      assignedId = assignedId ?? j.id ?? j.feed_id ?? null;
    } catch {
      // ignore non-JSON response body
    }
    await env.DB.prepare(
      `UPDATE project_catalog_submission
          SET status = 'active',
              last_submitted_at = ?,
              last_error = NULL,
              external_feed_id = COALESCE(?, external_feed_id)
        WHERE project_id = ? AND catalog = 'mobility_db'`,
    )
      .bind(Date.now(), assignedId, input.projectId)
      .run();
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await env.DB.prepare(
      `UPDATE project_catalog_submission
          SET status = 'error', last_submitted_at = ?, last_error = ?
        WHERE project_id = ? AND catalog = 'mobility_db'`,
    )
      .bind(Date.now(), message.slice(0, 500), input.projectId)
      .run();
  }
}

async function submitToTransitLand(env: Env, input: SubmissionInput): Promise<void> {
  // TODO(transit_land): transit.land's public submission requires per-account
  // credentials and the primary contribution channel is a PR against
  // https://github.com/transitland/transitland-atlas. We record the intent
  // here so the UI can show it; an operator follows up manually.
  await env.DB.prepare(
    `UPDATE project_catalog_submission
        SET status = 'pending',
            last_submitted_at = ?,
            last_error = 'transit_land submission pending manual review'
      WHERE project_id = ? AND catalog = 'transit_land'`,
  )
    .bind(Date.now(), input.projectId)
    .run();
}
