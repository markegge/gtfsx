// D1 access for service alerts, shared by the authoring API
// (worker/projects/alerts.ts) and the public feed serving path
// (worker/publication/feeds.ts). Kept separate from render.ts (pure) and from
// the authoring router so the public serve path never imports authoring code.

import type { Env } from '../env';
import {
  isAlertActiveAt,
  type ActivePeriod,
  type AlertRecord,
  type InformedEntity,
} from './render';

/** Raw `service_alert` row as stored in D1 (JSON arrays still strings). */
export interface AlertRow {
  id: string;
  project_id: string;
  cause: string;
  effect: string;
  severity_level: string;
  header_text: string;
  description_text: string | null;
  url: string | null;
  active_periods: string;
  informed_entities: string;
  status: string;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
}

/** The JSON shape returned by the authoring API (snake_case to match GTFS-RT). */
export interface AlertApi {
  id: string;
  cause: string;
  effect: string;
  severity_level: string;
  header_text: string;
  description_text: string | null;
  url: string | null;
  active_periods: ActivePeriod[];
  informed_entities: InformedEntity[];
  status: 'draft' | 'active';
  created_at: number;
  updated_at: number;
}

function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** DB row → API object (parses the JSON array columns). */
export function rowToApi(row: AlertRow): AlertApi {
  return {
    id: row.id,
    cause: row.cause,
    effect: row.effect,
    severity_level: row.severity_level,
    header_text: row.header_text,
    description_text: row.description_text,
    url: row.url,
    active_periods: parseJsonArray<ActivePeriod>(row.active_periods),
    informed_entities: parseJsonArray<InformedEntity>(row.informed_entities),
    status: row.status === 'active' ? 'active' : 'draft',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** DB row → the pure record render.ts consumes. */
export function rowToRecord(row: AlertRow): AlertRecord {
  return {
    id: row.id,
    cause: row.cause,
    effect: row.effect,
    severity_level: row.severity_level,
    header_text: row.header_text,
    description_text: row.description_text,
    url: row.url,
    active_periods: parseJsonArray<ActivePeriod>(row.active_periods),
    informed_entities: parseJsonArray<InformedEntity>(row.informed_entities),
  };
}

const SELECT_COLS = `id, project_id, cause, effect, severity_level, header_text, description_text,
  url, active_periods, informed_entities, status, created_by_user_id, created_at, updated_at`;

/** All alerts for a project, newest first (authoring list view). */
export async function listAlertRows(env: Env, projectId: string): Promise<AlertRow[]> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM service_alert WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(projectId)
    .all<AlertRow>();
  return res.results ?? [];
}

export async function getAlertRow(env: Env, projectId: string, alertId: string): Promise<AlertRow | null> {
  return env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM service_alert WHERE id = ? AND project_id = ?`,
  )
    .bind(alertId, projectId)
    .first<AlertRow>();
}

/**
 * The currently-servable alerts for a project: status='active' AND within an
 * active_period at `nowSec`. Used by both the live feed and the editor preview
 * so they agree exactly.
 */
export async function loadActiveAlertRecords(
  env: Env,
  projectId: string,
  nowSec: number,
): Promise<AlertRecord[]> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS} FROM service_alert WHERE project_id = ? AND status = 'active'`,
  )
    .bind(projectId)
    .all<AlertRow>();
  return (res.results ?? [])
    .map(rowToRecord)
    .filter((r) => isAlertActiveAt(r.active_periods, nowSec));
}

export async function countAlerts(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_alert WHERE project_id = ?`)
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
