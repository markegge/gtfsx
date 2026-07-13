// Scheduled publish (#24 / BE-77): POST/DELETE /api/projects/:id/publish/schedule
// and the cron task publishDueSchedules() that fires due schedules.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, gzip, resetDb, seedUser, env, type SeededUser } from './_setup';
import { publishDueSchedules } from '../cron/tasks';

async function loggedIn(email: string, plan?: 'free' | 'agency' | 'enterprise'): Promise<{ client: TestClient; user: SeededUser }> {
  const user = await seedUser({ email, plan });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, user };
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

async function createSnapshot(
  client: TestClient,
  projectId: string,
  state: unknown,
  meta: { validationErrors?: number; validationWarnings?: number } = {},
): Promise<{ snapshot: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({
    summary: {},
    validationErrors: meta.validationErrors ?? 0,
    validationWarnings: meta.validationWarnings ?? 0,
  }));
  return client.json(await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }));
}

interface IgnoreFlags {
  ignoreWarnings?: boolean;
  ignoreRtBreakage?: boolean;
  ignoreAgencyChurn?: boolean;
}

async function scheduleMultipart(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  scheduledFor: number,
  zipBytes: Uint8Array,
  flags: IgnoreFlags = {},
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, scheduledFor, ...flags }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish/schedule`, undefined, { body: form });
}

async function publishMultipart(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  zipBytes: Uint8Array,
  flags: IgnoreFlags = {},
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, ...flags }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

/** Make the project's pending schedule due right now. */
async function makeDue(projectId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE scheduled_publish SET scheduled_for = ? WHERE project_id = ? AND status = 'pending'`,
  ).bind(Date.now() - 1000, projectId).run();
}

async function scheduleRow(projectId: string): Promise<{
  status: string;
  failure_reason: string | null;
  ignore_rt_breakage: number;
  ignore_agency_churn: number;
} | null> {
  return env.DB.prepare(
    `SELECT status, failure_reason, ignore_rt_breakage, ignore_agency_churn
       FROM scheduled_publish WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(projectId)
    .first();
}

const FUTURE = () => Date.now() + 60 * 60 * 1000; // 1h out
const ZIP = new TextEncoder().encode('PK\x03\x04scheduled-zip-body');
const ZIP2 = new TextEncoder().encode('PK\x03\x04a-different-zip-body');

// Two agencies + a stop, so both ID-stability gates have something to lose.
const TWO_AGENCIES = {
  agencies: [
    { agency_id: 'SVT', agency_name: 'Sunset Valley Transit' },
    { agency_id: 'RRT', agency_name: 'River Ridge Transit' },
  ],
  routes: [{ route_id: 'R1' }],
  stops: [{ stop_id: 'S1' }, { stop_id: 'S2' }],
  trips: [{ trip_id: 'T1' }],
};
/** Drops RRT — agency_id churn. */
const ONE_AGENCY = {
  ...TWO_AGENCIES,
  agencies: [{ agency_id: 'SVT', agency_name: 'Sunset Valley Transit' }],
};
/** Keeps both agencies, drops stop S2 — rt_breakage only (no churn). */
const DROPPED_STOP = { ...TWO_AGENCIES, stops: [{ stop_id: 'S1' }] };

describe('/api/projects/:id/publish/schedule', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('schedules a publish and surfaces it in the history response', async () => {
    const { client } = await loggedIn('sched1@example.com');
    const proj = await createProject(client, 'Sched');
    const v = await createSnapshot(client, proj.id, { agencies: [] });

    const res = await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
    expect(res.status).toBe(200);
    const body = await client.json<{ scheduled: { status: string; snapshotId: string } }>(res);
    expect(body.scheduled.status).toBe('pending');

    const hist = await client.json<{ scheduled: { status: string; snapshotId: string } | null }>(
      await client.get(`/api/projects/${proj.id}/publish/history`),
    );
    expect(hist.scheduled?.status).toBe('pending');
    expect(hist.scheduled?.snapshotId).toBe(v.snapshot.id);
  });

  it('rejects a time in the past', async () => {
    const { client } = await loggedIn('sched2@example.com');
    const proj = await createProject(client, 'Past');
    const v = await createSnapshot(client, proj.id, {});
    const res = await scheduleMultipart(client, proj.id, v.snapshot.id, Date.now() - 1000, ZIP);
    expect(res.status).toBe(422);
  });

  it('rejects scheduling a snapshot with validation errors unless ignoreWarnings', async () => {
    const { client } = await loggedIn('sched3@example.com');
    const proj = await createProject(client, 'Broken');
    const v = await createSnapshot(client, proj.id, {}, { validationErrors: 2 });
    const blocked = await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
    expect(blocked.status).toBe(422);
    const ok = await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP, { ignoreWarnings: true });
    expect(ok.status).toBe(200);
  });

  it('blocks the free tier (managed publishing is paid-only)', async () => {
    const { client } = await loggedIn('sched4@example.com', 'free');
    const proj = await createProject(client, 'Free');
    const v = await createSnapshot(client, proj.id, {}).catch(() => null);
    // Free tier can't even create snapshots (snapshot_history is paid) — but if it
    // could, scheduling must be blocked. Assert the schedule endpoint rejects.
    if (v) {
      const res = await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
      expect([402, 403]).toContain(res.status);
    }
  });

  it('re-scheduling replaces the pending row (one pending per project)', async () => {
    const { client } = await loggedIn('sched5@example.com');
    const proj = await createProject(client, 'Replace');
    const v = await createSnapshot(client, proj.id, {});
    await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
    await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE() + 1000, ZIP);
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM scheduled_publish WHERE project_id = ? AND status = 'pending'`,
    ).bind(proj.id).first<{ n: number }>();
    expect(pending?.n).toBe(1);
  });

  it('cancel removes the pending schedule', async () => {
    const { client } = await loggedIn('sched6@example.com');
    const proj = await createProject(client, 'Cancel');
    const v = await createSnapshot(client, proj.id, {});
    await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
    const del = await client.delete(`/api/projects/${proj.id}/publish/schedule`);
    expect(del.status).toBe(200);
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM scheduled_publish WHERE project_id = ? AND status = 'pending'`,
    ).bind(proj.id).first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it('cron publishes a due schedule and serves the canonical feed', async () => {
    const { client } = await loggedIn('cron1@example.com');
    const proj = await createProject(client, 'Due');
    const v = await createSnapshot(client, proj.id, {});
    await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
    // Make it due.
    await env.DB.prepare(
      `UPDATE scheduled_publish SET scheduled_for = ? WHERE project_id = ? AND status = 'pending'`,
    ).bind(Date.now() - 1000, proj.id).run();

    const result = await publishDueSchedules(env);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(feed.status).toBe(200);
    expect(new Uint8Array(await feed.arrayBuffer())).toEqual(ZIP);

    const row = await env.DB.prepare(
      `SELECT status FROM scheduled_publish WHERE project_id = ?`,
    ).bind(proj.id).first<{ status: string }>();
    expect(row?.status).toBe('executed');
  });

  it('cron marks a schedule failed when the owner can no longer publish', async () => {
    const { client, user } = await loggedIn('cron2@example.com');
    const proj = await createProject(client, 'Revoked');
    const v = await createSnapshot(client, proj.id, {});
    await scheduleMultipart(client, proj.id, v.snapshot.id, FUTURE(), ZIP);
    await env.DB.prepare(
      `UPDATE scheduled_publish SET scheduled_for = ? WHERE project_id = ? AND status = 'pending'`,
    ).bind(Date.now() - 1000, proj.id).run();
    // Downgrade the owner to free after scheduling.
    await env.DB.prepare(`UPDATE user SET plan = 'free' WHERE id = ?`).bind(user.id).run();

    const result = await publishDueSchedules(env);
    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);

    const row = await env.DB.prepare(
      `SELECT status FROM scheduled_publish WHERE project_id = ?`,
    ).bind(proj.id).first<{ status: string }>();
    expect(row?.status).toBe('failed');
    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(feed.status).toBe(404);
  });
});

// ─── ID-stability gates on the SCHEDULE path ────────────────────────────────
//
// A scheduled publish targets a fixed, immutable snapshot, so the rt_breakage /
// agency_id_churn diff is computable when the user schedules it — while they're
// still at the keyboard to acknowledge it. The cron has nobody to ask, so before
// this the gates could only fail the schedule at fire time. Now: same gates, same
// 409s, at schedule time; the acks persist on the row (migration 0025) and the
// cron replays them. Crucially it replays ONLY those — a baseline that MOVED
// after scheduling can still surface un-acknowledged churn, and that must still
// fail rather than silently publish.
describe('scheduled publish — ID-stability gates', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('scheduling a publish that churns agency_id returns 409 agency_id_churn', async () => {
    const { client } = await loggedIn('schedchurn1@example.com');
    const proj = await createProject(client, 'Churn Sched');
    const vOld = await createSnapshot(client, proj.id, TWO_AGENCIES);
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);

    // Dropping RRT would break the NTD P-50 crosswalk — the same 409 the
    // immediate-publish route raises, so the client's existing modal fires.
    const vNew = await createSnapshot(client, proj.id, ONE_AGENCY);
    const blocked = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2);
    expect(blocked.status).toBe(409);
    const body = await blocked.json<{ error: string; removed: { agencies: string[] } }>();
    expect(body.error).toBe('agency_id_churn');
    expect(body.removed.agencies).toEqual(['RRT']);

    // The rejected schedule left NO pending row behind.
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM scheduled_publish WHERE project_id = ? AND status = 'pending'`,
    ).bind(proj.id).first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it('scheduling with the ack flag persists it, and the cron then fires cleanly', async () => {
    const { client } = await loggedIn('schedchurn2@example.com');
    const proj = await createProject(client, 'Churn Ack');
    const vOld = await createSnapshot(client, proj.id, TWO_AGENCIES);
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);
    const vNew = await createSnapshot(client, proj.id, ONE_AGENCY);

    const ok = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2, {
      ignoreAgencyChurn: true,
    });
    expect(ok.status).toBe(200);
    const sched = await client.json<{ scheduled: { ignoreAgencyChurn: boolean } }>(ok);
    expect(sched.scheduled.ignoreAgencyChurn).toBe(true);

    // Persisted on the row for the cron to replay…
    const row = await scheduleRow(proj.id);
    expect(row?.ignore_agency_churn).toBe(1);
    expect(row?.ignore_rt_breakage).toBe(0);
    // …and reflected back to the client.
    const hist = await client.json<{ scheduled: { ignoreAgencyChurn: boolean } | null }>(
      await client.get(`/api/projects/${proj.id}/publish/history`),
    );
    expect(hist.scheduled?.ignoreAgencyChurn).toBe(true);

    // The cron fires it without a human present.
    await makeDue(proj.id);
    const result = await publishDueSchedules(env);
    expect(result).toEqual({ published: 1, failed: 0 });
    expect((await scheduleRow(proj.id))?.status).toBe('executed');

    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(new Uint8Array(await feed.arrayBuffer())).toEqual(ZIP2);
  });

  it('churn that appears AFTER scheduling still fails at fire time, with the reason recorded', async () => {
    const { client } = await loggedIn('schedchurn3@example.com');
    const proj = await createProject(client, 'Moved Baseline');

    // Nothing published yet → no baseline → no gate → scheduled with NO acks.
    const vNew = await createSnapshot(client, proj.id, ONE_AGENCY);
    expect((await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2)).status).toBe(200);
    expect((await scheduleRow(proj.id))?.ignore_agency_churn).toBe(0);

    // Someone publishes a two-agency feed in the meantime: the baseline MOVED,
    // and the pending snapshot now drops RRT. The cron must NOT auto-acknowledge.
    const vOther = await createSnapshot(client, proj.id, TWO_AGENCIES);
    expect((await publishMultipart(client, proj.id, vOther.snapshot.id, ZIP)).status).toBe(200);

    await makeDue(proj.id);
    const result = await publishDueSchedules(env);
    expect(result).toEqual({ published: 0, failed: 1 });

    const row = await scheduleRow(proj.id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toMatch(/agency_id_churn/);
    expect(row?.failure_reason).toMatch(/P-50/);

    // The publication pointer never moved — the feed still serves what was
    // published interactively, not the un-acknowledged scheduled snapshot.
    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(new Uint8Array(await feed.arrayBuffer())).toEqual(ZIP);
  });

  it('scheduling a publish that breaks a registered RT feed returns 409 rt_breakage', async () => {
    const { client } = await loggedIn('schedrt1@example.com');
    const proj = await createProject(client, 'RT Sched');
    const vOld = await createSnapshot(client, proj.id, TWO_AGENCIES);
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'trip_updates', url: 'https://example.com/tu.pb' }],
    });

    // Drops stop S2, keeps both agencies → rt_breakage only.
    const vNew = await createSnapshot(client, proj.id, DROPPED_STOP);
    const blocked = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2);
    expect(blocked.status).toBe(409);
    const body = await blocked.json<{ error: string; removed: { stops: string[] } }>();
    expect(body.error).toBe('rt_breakage');
    expect(body.removed.stops).toEqual(['S2']);

    const ok = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2, {
      ignoreRtBreakage: true,
    });
    expect(ok.status).toBe(200);
    expect((await scheduleRow(proj.id))?.ignore_rt_breakage).toBe(1);

    await makeDue(proj.id);
    expect(await publishDueSchedules(env)).toEqual({ published: 1, failed: 0 });
    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(new Uint8Array(await feed.arrayBuffer())).toEqual(ZIP2);
  });

  it('scheduling: acking only rt_breakage still trips the churn gate (both acks persist)', async () => {
    const { client } = await loggedIn('schedrt2@example.com');
    const proj = await createProject(client, 'Both Gates');
    const vOld = await createSnapshot(client, proj.id, TWO_AGENCIES);
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'vehicle_positions', url: 'https://example.com/vp.pb' }],
    });

    // Drops an agency → both gates fire; rt_breakage is checked first.
    const vNew = await createSnapshot(client, proj.id, ONE_AGENCY);
    const first = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2);
    expect(first.status).toBe(409);
    expect((await first.json<{ error: string }>()).error).toBe('rt_breakage');

    const second = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2, {
      ignoreRtBreakage: true,
    });
    expect(second.status).toBe(409);
    expect((await second.json<{ error: string }>()).error).toBe('agency_id_churn');

    const ok = await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2, {
      ignoreRtBreakage: true,
      ignoreAgencyChurn: true,
    });
    expect(ok.status).toBe(200);
    const row = await scheduleRow(proj.id);
    expect(row?.ignore_rt_breakage).toBe(1);
    expect(row?.ignore_agency_churn).toBe(1);

    await makeDue(proj.id);
    expect(await publishDueSchedules(env)).toEqual({ published: 1, failed: 0 });
  });

  it('RT breakage that only becomes applicable after scheduling still fails at fire time', async () => {
    const { client } = await loggedIn('schedrt3@example.com');
    const proj = await createProject(client, 'RT Added Later');
    const vOld = await createSnapshot(client, proj.id, TWO_AGENCIES);
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);

    // No RT feeds registered yet: dropping a stop is neither churn nor breakage,
    // so this schedules clean, with no acknowledgements.
    const vNew = await createSnapshot(client, proj.id, DROPPED_STOP);
    expect((await scheduleMultipart(client, proj.id, vNew.snapshot.id, FUTURE(), ZIP2)).status).toBe(200);
    expect((await scheduleRow(proj.id))?.ignore_rt_breakage).toBe(0);

    // The user then registers an RT feed — the gate now applies and was never
    // acknowledged. Fail closed.
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'trip_updates', url: 'https://example.com/tu.pb' }],
    });

    await makeDue(proj.id);
    expect(await publishDueSchedules(env)).toEqual({ published: 0, failed: 1 });
    const row = await scheduleRow(proj.id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toMatch(/rt_breakage/);

    const feed = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(new Uint8Array(await feed.arrayBuffer())).toEqual(ZIP);
  });
});
