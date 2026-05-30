// Service Alerts authoring API, mounted under /api/projects/:id/alerts.
//
// Alerts are project-scoped and DECOUPLED from publish: they have their own
// CRUD + activate lifecycle and are served live (worker/publication/feeds.ts).
// All endpoints require project 'editor' access AND the 'service_alerts'
// feature (Agency+); the *served* feeds are public (gated only here).
//
// RT coexistence (Option A): authoring alerts upserts a managed project_rt_feed
// row (kind='alerts', managed=1) pointing at our alerts.pb so feed_info.json
// advertises it. If the project already has an *external* alerts feed we don't
// auto-wire (never two) and surface a conflict the UI resolves.

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, Env } from '../env';
import { notFound } from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
import type { OwnerType } from './quotas';
import { requireOwnerFeature } from '../billing/middleware';
import { loadEmbedFeed } from '../embeds/loader';
import { requireOwnedProject, parseJson } from './routes';
import {
  isValidCause,
  isValidEffect,
  isValidSeverity,
  buildFeedMessage,
  feedMessageToJson,
} from '../alerts/render';
import {
  listAlertRows,
  getAlertRow,
  rowToApi,
  loadActiveAlertRecords,
  countAlerts,
  type AlertRow,
} from '../alerts/store';

// ─── Validation ──────────────────────────────────────────────────────────────

const activePeriodSchema = z
  .object({
    start: z.number().int().nonnegative().nullable().optional(),
    end: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((p) => p.start == null || p.end == null || p.end > p.start, {
    message: 'active_period end must be after start',
  });

const informedEntitySchema = z
  .object({
    agency_id: z.string().max(255).optional(),
    route_id: z.string().max(255).optional(),
    route_type: z.number().int().optional(),
    direction_id: z.number().int().min(0).max(1).optional(),
    trip_id: z.string().max(255).optional(),
    stop_id: z.string().max(255).optional(),
  })
  .refine(
    (e) =>
      !!e.agency_id || !!e.route_id || e.route_type != null || !!e.trip_id || !!e.stop_id,
    { message: 'each informed_entity needs at least one selector' },
  );

const alertInputSchema = z.object({
  cause: z.string().default('UNKNOWN_CAUSE').refine(isValidCause, 'invalid cause'),
  effect: z.string().default('UNKNOWN_EFFECT').refine(isValidEffect, 'invalid effect'),
  severity_level: z
    .string()
    .default('UNKNOWN_SEVERITY')
    .refine(isValidSeverity, 'invalid severity_level'),
  header_text: z.string().min(1, 'header_text is required').max(1000),
  description_text: z.string().max(4000).nullable().optional(),
  url: z.string().url().max(2000).nullable().optional(),
  active_periods: z.array(activePeriodSchema).max(50).default([]),
  informed_entities: z.array(informedEntitySchema).min(1, 'at least one informed_entity is required').max(200),
  status: z.enum(['draft', 'active']).optional(),
});

const statusPatchSchema = z.object({ status: z.enum(['draft', 'active']) });

const adoptRtFeedSchema = z.object({
  // 'replace_external' swaps an existing external alerts feed for our managed
  // one. ('keep_external' is the no-op the UI takes by simply not calling this.)
  resolution: z.literal('replace_external'),
});

// ─── RT coexistence helpers ──────────────────────────────────────────────────

interface RtCoexistence {
  /** Our auto-wired alerts.pb URL (managed=1), if present. */
  managed_feed_url: string | null;
  /** An externally-hosted alerts feed the agency registered (managed=0). */
  external_alerts_feed: { id: string; url: string } | null;
}

function managedAlertsUrl(env: Env, slug: string): string {
  return `${env.FEEDS_ORIGIN.replace(/\/$/, '')}/${slug}/alerts.pb`;
}

async function getRtCoexistence(env: Env, projectId: string): Promise<RtCoexistence> {
  const res = await env.DB.prepare(
    `SELECT id, url, managed FROM project_rt_feed WHERE project_id = ? AND kind = 'alerts'`,
  )
    .bind(projectId)
    .all<{ id: string; url: string; managed: number }>();
  const rows = res.results ?? [];
  const managed = rows.find((r) => r.managed === 1);
  const external = rows.find((r) => r.managed === 0);
  return {
    managed_feed_url: managed?.url ?? null,
    external_alerts_feed: external ? { id: external.id, url: external.url } : null,
  };
}

/**
 * Keep the managed project_rt_feed row in sync with whether the project has any
 * authored alerts. Returns the resulting coexistence state (incl. an external
 * conflict that blocked auto-wiring).
 */
async function syncManagedAlertsFeed(env: Env, projectId: string, slug: string): Promise<RtCoexistence> {
  const co = await getRtCoexistence(env, projectId);
  const url = managedAlertsUrl(env, slug);
  const hasAlerts = (await countAlerts(env, projectId)) > 0;

  if (!hasAlerts) {
    // Authoring cleared → drop our managed row (leave any external row alone).
    if (co.managed_feed_url != null) {
      await env.DB.prepare(
        `DELETE FROM project_rt_feed WHERE project_id = ? AND kind = 'alerts' AND managed = 1`,
      )
        .bind(projectId)
        .run();
    }
    return getRtCoexistence(env, projectId);
  }

  if (co.managed_feed_url != null) {
    // Already managed — keep the URL fresh (slug could have changed).
    if (co.managed_feed_url !== url) {
      await env.DB.prepare(
        `UPDATE project_rt_feed SET url = ? WHERE project_id = ? AND kind = 'alerts' AND managed = 1`,
      )
        .bind(url, projectId)
        .run();
    }
    return getRtCoexistence(env, projectId);
  }

  if (co.external_alerts_feed != null) {
    // Never two alerts feeds — don't auto-wire; UI resolves the conflict.
    return co;
  }

  await env.DB.prepare(
    `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at, managed)
     VALUES (?, ?, 'alerts', ?, ?, 1)`,
  )
    .bind(ulid(), projectId, url, Date.now())
    .run();
  return getRtCoexistence(env, projectId);
}

// ─── ID-validation warnings (non-blocking) ───────────────────────────────────

async function entityWarnings(
  env: Env,
  slug: string,
  entities: z.infer<typeof informedEntitySchema>[],
): Promise<string[]> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return []; // not published yet → nothing to validate against
  const routeIds = new Set(feed.state.routes.map((r) => r.route_id));
  const stopIds = new Set(feed.state.stops.map((s) => s.stop_id));
  const agencyIds = new Set(feed.state.agencies.map((a) => a.agency_id));
  const warnings: string[] = [];
  for (const e of entities) {
    if (e.route_id && !routeIds.has(e.route_id)) {
      warnings.push(`Route "${e.route_id}" is not in the published feed.`);
    }
    if (e.stop_id && !stopIds.has(e.stop_id)) {
      warnings.push(`Stop "${e.stop_id}" is not in the published feed.`);
    }
    if (e.agency_id && !agencyIds.has(e.agency_id)) {
      warnings.push(`Agency "${e.agency_id}" is not in the published feed.`);
    }
  }
  return warnings;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function alertRowFromInput(
  id: string,
  projectId: string,
  userId: string | null,
  input: z.infer<typeof alertInputSchema>,
  now: number,
  createdAt: number,
): AlertRow {
  return {
    id,
    project_id: projectId,
    cause: input.cause,
    effect: input.effect,
    severity_level: input.severity_level,
    header_text: input.header_text,
    description_text: input.description_text ?? null,
    url: input.url ?? null,
    active_periods: JSON.stringify(input.active_periods),
    informed_entities: JSON.stringify(input.informed_entities),
    status: input.status ?? 'draft',
    created_by_user_id: userId,
    created_at: createdAt,
    updated_at: now,
  };
}

export function registerAlertRoutes(router: Hono<AppContext>): void {
  // List all alerts for the project (+ coexistence state for the UI banner).
  router.get('/:id/alerts', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    const rows = await listAlertRows(c.env, project.id);
    const rt_coexistence = await getRtCoexistence(c.env, project.id);
    return c.json({ alerts: rows.map(rowToApi), rt_coexistence });
  });

  // Preview: the GTFS-RT JSON the live feed would emit right now.
  router.get('/:id/alerts/preview.json', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    const nowSec = Math.floor(Date.now() / 1000);
    const records = await loadActiveAlertRecords(c.env, project.id, nowSec);
    const message = buildFeedMessage(records, { timestamp: nowSec });
    return c.json(feedMessageToJson(message));
  });

  // Create.
  router.post('/:id/alerts', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    const input = await parseJson(c, alertInputSchema);
    const now = Date.now();
    const row = alertRowFromInput(ulid(), project.id, user.id, input, now, now);

    await c.env.DB.prepare(
      `INSERT INTO service_alert
         (id, project_id, cause, effect, severity_level, header_text, description_text, url,
          active_periods, informed_entities, status, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id, row.project_id, row.cause, row.effect, row.severity_level, row.header_text,
        row.description_text, row.url, row.active_periods, row.informed_entities, row.status,
        row.created_by_user_id, row.created_at, row.updated_at,
      )
      .run();

    const warnings = await entityWarnings(c.env, project.slug, input.informed_entities);
    const rt_coexistence = await syncManagedAlertsFeed(c.env, project.id, project.slug);

    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'project',
      subjectId: project.id,
      action: 'project.alert_create',
      metadata: { alertId: row.id, status: row.status },
      ip: clientIp(c.req.raw),
    });

    return c.json({ alert: rowToApi(row), warnings, rt_coexistence }, 201);
  });

  // Edit.
  router.put('/:id/alerts/:alertId', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const alertId = c.req.param('alertId');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    const existing = await getAlertRow(c.env, project.id, alertId);
    if (!existing) throw notFound('Alert not found');

    const input = await parseJson(c, alertInputSchema);
    const now = Date.now();
    // Status defaults to its existing value on edit (use PATCH to change it).
    const status = input.status ?? (existing.status === 'active' ? 'active' : 'draft');
    const row = alertRowFromInput(alertId, project.id, existing.created_by_user_id, { ...input, status }, now, existing.created_at);

    await c.env.DB.prepare(
      `UPDATE service_alert
          SET cause = ?, effect = ?, severity_level = ?, header_text = ?, description_text = ?,
              url = ?, active_periods = ?, informed_entities = ?, status = ?, updated_at = ?
        WHERE id = ? AND project_id = ?`,
    )
      .bind(
        row.cause, row.effect, row.severity_level, row.header_text, row.description_text,
        row.url, row.active_periods, row.informed_entities, row.status, row.updated_at,
        alertId, project.id,
      )
      .run();

    const warnings = await entityWarnings(c.env, project.slug, input.informed_entities);
    const rt_coexistence = await getRtCoexistence(c.env, project.id);
    return c.json({ alert: rowToApi(row), warnings, rt_coexistence });
  });

  // Activate / deactivate.
  router.patch('/:id/alerts/:alertId', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const alertId = c.req.param('alertId');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    const existing = await getAlertRow(c.env, project.id, alertId);
    if (!existing) throw notFound('Alert not found');

    const { status } = await parseJson(c, statusPatchSchema);
    const now = Date.now();
    await c.env.DB.prepare(`UPDATE service_alert SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?`)
      .bind(status, now, alertId, project.id)
      .run();

    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'project',
      subjectId: project.id,
      action: 'project.alert_status',
      metadata: { alertId, status },
      ip: clientIp(c.req.raw),
    });

    const updated = await getAlertRow(c.env, project.id, alertId);
    return c.json({ alert: updated ? rowToApi(updated) : null });
  });

  // Delete.
  router.delete('/:id/alerts/:alertId', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const alertId = c.req.param('alertId');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    const existing = await getAlertRow(c.env, project.id, alertId);
    if (!existing) throw notFound('Alert not found');

    await c.env.DB.prepare(`DELETE FROM service_alert WHERE id = ? AND project_id = ?`)
      .bind(alertId, project.id)
      .run();

    // Drops the managed rt_feed row if that was the last alert.
    await syncManagedAlertsFeed(c.env, project.id, project.slug);

    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'project',
      subjectId: project.id,
      action: 'project.alert_delete',
      metadata: { alertId },
      ip: clientIp(c.req.raw),
    });
    return c.body(null, 204);
  });

  // Resolve the "two alerts feeds" conflict by adopting ours over the external.
  router.post('/:id/alerts/rt-feed', async (c) => {
    const user = c.var.user!;
    const id = c.req.param('id');
    const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
    await requireOwnerFeature(c.env, project.owner_type as OwnerType, project.owner_id, 'service_alerts', user);

    await parseJson(c, adoptRtFeedSchema);
    // Remove the external alerts feed, then (re)wire ours.
    await c.env.DB.prepare(
      `DELETE FROM project_rt_feed WHERE project_id = ? AND kind = 'alerts' AND managed = 0`,
    )
      .bind(project.id)
      .run();
    const rt_coexistence = await syncManagedAlertsFeed(c.env, project.id, project.slug);

    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'project',
      subjectId: project.id,
      action: 'project.alert_rt_adopt',
      metadata: {},
      ip: clientIp(c.req.raw),
    });
    return c.json({ rt_coexistence });
  });
}
