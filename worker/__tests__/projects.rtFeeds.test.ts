// /api/projects/:id/rt-feeds — PUT replaces; GET lists; DELETE removes one.
// Plus the ID-stability gate: dropping a stop_id between versions, with an
// RT feed registered, triggers 409 rt_breakage unless the caller opts in.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

async function createSnapshot(client: TestClient, projectId: string, state: unknown): Promise<{ snapshot: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.json(await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }));
}

async function publishMultipart(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  zipBytes: Uint8Array,
  flags: { ignoreRtBreakage?: boolean } = {},
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, ...flags }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

describe('/api/projects/:id/rt-feeds', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('PUT + GET + DELETE round-trip', async () => {
    const client = await loggedInClient('rt1@example.com');
    const proj = await createProject(client, 'RT');

    const put = await client.json<{ feeds: { id: string; kind: string; url: string }[] }>(
      await client.put(`/api/projects/${proj.id}/rt-feeds`, {
        feeds: [
          { kind: 'vehicle_positions', url: 'https://example.com/vp.pb' },
          { kind: 'trip_updates', url: 'https://example.com/tu.pb' },
        ],
      }),
    );
    expect(put.feeds).toHaveLength(2);

    const listed = await client.json<{ feeds: { id: string; kind: string; url: string }[] }>(
      await client.get(`/api/projects/${proj.id}/rt-feeds`),
    );
    expect(listed.feeds.map((f) => f.kind).sort()).toEqual(['trip_updates', 'vehicle_positions']);

    const toDelete = listed.feeds[0].id;
    const del = await client.delete(`/api/projects/${proj.id}/rt-feeds/${toDelete}`);
    expect(del.status).toBe(204);

    const after = await client.json<{ feeds: unknown[] }>(
      await client.get(`/api/projects/${proj.id}/rt-feeds`),
    );
    expect(after.feeds).toHaveLength(1);
  });

  it('rejects non-https url shapes with 422', async () => {
    const client = await loggedInClient('rt2@example.com');
    const proj = await createProject(client, 'RT2');

    const bad = await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'alerts', url: 'http://not-secure.example.com/a.pb' }],
    });
    expect(bad.status).toBe(422);

    const notUrl = await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'alerts', url: 'nope' }],
    });
    expect(notUrl.status).toBe(422);

    const unknownKind = await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'not-a-kind', url: 'https://example.com/a.pb' }],
    });
    expect(unknownKind.status).toBe(422);
  });

  it('ID-stability: removing a stop_id → publish returns 409 rt_breakage; ignoreRtBreakage allows it', async () => {
    const client = await loggedInClient('rt3@example.com');
    const proj = await createProject(client, 'RT3');
    const vOld = await createSnapshot(client, proj.id, {
      agencies: [{ agency_id: 'A' }],
      routes: [{ route_id: 'R1' }],
      stops: [{ stop_id: 'S1' }, { stop_id: 'S2' }],
      trips: [{ trip_id: 'T1' }],
    });
    // Publish the baseline before registering the RT feed — this establishes
    // "currently published" state for the diff.
    const pubRes1 = await publishMultipart(client, proj.id, vOld.snapshot.id, new Uint8Array([0xde, 0xad]));
    expect(pubRes1.status).toBe(200);

    // Now register an RT feed — subsequent publishes must ID-check.
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'trip_updates', url: 'https://example.com/tu.pb' }],
    });

    // New version drops S2.
    const vNew = await createSnapshot(client, proj.id, {
      agencies: [{ agency_id: 'A' }],
      routes: [{ route_id: 'R1' }],
      stops: [{ stop_id: 'S1' }],
      trips: [{ trip_id: 'T1' }],
    });

    const blocked = await publishMultipart(client, proj.id, vNew.snapshot.id, new Uint8Array([0xbe, 0xef]));
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { error: string; removed: { stops: string[] } };
    expect(body.error).toBe('rt_breakage');
    expect(body.removed.stops).toEqual(['S2']);

    const allowed = await publishMultipart(
      client, proj.id, vNew.snapshot.id, new Uint8Array([0xbe, 0xef]), { ignoreRtBreakage: true },
    );
    expect(allowed.status).toBe(200);
  });

  it('non-owner cannot access RT feeds (404)', async () => {
    const { client: alice } = { client: await loggedInClient('rt4-a@example.com') };
    const proj = await createProject(alice, 'RT4');
    const { client: bob } = { client: await loggedInClient('rt4-b@example.com') };
    const res = await bob.get(`/api/projects/${proj.id}/rt-feeds`);
    expect(res.status).toBe(404);
  });
});
