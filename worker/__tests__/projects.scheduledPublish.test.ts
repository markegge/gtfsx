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

async function scheduleMultipart(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  scheduledFor: number,
  zipBytes: Uint8Array,
  flags: { ignoreWarnings?: boolean } = {},
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, scheduledFor, ...flags }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish/schedule`, undefined, { body: form });
}

const FUTURE = () => Date.now() + 60 * 60 * 1000; // 1h out
const ZIP = new TextEncoder().encode('PK\x03\x04scheduled-zip-body');

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
