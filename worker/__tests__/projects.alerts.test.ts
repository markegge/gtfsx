// GTFS-Realtime Service Alerts: render mapping, active_period filtering, the
// authoring API (CRUD + gating + validation), public serving (.pb/.json), and
// RT coexistence (Option A managed project_rt_feed).

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ulid } from 'ulidx';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { makeClient, type TestClient } from './_client';
import { resetDb, seedUser, dbRun, env as testEnv } from './_setup';
import {
  toAlert,
  buildFeedMessage,
  encodeFeedMessage,
  decodeFeedMessage,
  isAlertActiveAt,
  type AlertRecord,
} from '../alerts/render';

type Plan = 'free' | 'pro' | 'agency' | 'enterprise';

async function loggedIn(email: string, plan?: Plan): Promise<TestClient> {
  const user = await seedUser({ email, ...(plan ? { plan } : {}) });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  const res = await client.post('/api/projects', { name });
  if (res.status !== 201) throw new Error(`create project failed: ${res.status}`);
  return client.json<{ id: string; slug: string }>(res);
}

// Publish minimally so the feeds handler's loadPublication() resolves the slug
// (serveAlerts only needs the publication→project link, not R2 state).
async function publish(projectId: string, slug: string): Promise<void> {
  const sid = ulid();
  const now = Date.now();
  await dbRun(
    `INSERT INTO feed_snapshot (id, project_id, state_r2_key, zip_r2_key, zip_size, summary_json, created_at)
     VALUES (?, ?, 's', 'z', 10, '{}', ?)`,
    sid, projectId, now,
  );
  await dbRun(
    `INSERT INTO publication (project_id, snapshot_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, 'z')`,
    projectId, sid, now, slug,
  );
}

const ACTIVE_ALERT = {
  cause: 'CONSTRUCTION',
  effect: 'DETOUR',
  severity_level: 'WARNING',
  header_text: 'Route 5 detour around Main St',
  informed_entities: [{ route_id: 'R5', direction_id: 0 }],
  active_periods: [] as { start?: number | null; end?: number | null }[],
  status: 'active' as const,
};

beforeEach(async () => {
  await resetDb();
});

// ─── Pure render ──────────────────────────────────────────────────────────────

describe('render: row → GTFS-RT Alert', () => {
  const base: AlertRecord = {
    id: 'a1',
    cause: 'CONSTRUCTION',
    effect: 'DETOUR',
    severity_level: 'WARNING',
    header_text: 'Detour',
    description_text: 'Buses reroute via 2nd Ave',
    url: 'https://agency.gov/alerts/5',
    active_periods: [{ start: 100, end: 200 }],
    informed_entities: [{ route_id: 'R1', direction_id: 1 }, { stop_id: 'S1' }, { agency_id: 'A1' }],
  };

  it('maps enums, TranslatedString, entities and periods', () => {
    const alert = toAlert(base, 'en');
    expect(alert.cause).toBe(transit_realtime.Alert.Cause.CONSTRUCTION);
    expect(alert.effect).toBe(transit_realtime.Alert.Effect.DETOUR);
    expect(alert.severityLevel).toBe(transit_realtime.Alert.SeverityLevel.WARNING);
    expect(alert.headerText?.translation?.[0]).toMatchObject({ text: 'Detour', language: 'en' });
    expect(alert.descriptionText?.translation?.[0]?.text).toBe('Buses reroute via 2nd Ave');
    expect(alert.url?.translation?.[0]?.text).toBe('https://agency.gov/alerts/5');
    expect(alert.activePeriod?.[0]).toMatchObject({ start: 100, end: 200 });
    expect(alert.informedEntity).toHaveLength(3);
    expect(alert.informedEntity?.[0]).toMatchObject({ routeId: 'R1', directionId: 1 });
    expect(alert.informedEntity?.[1]?.stopId).toBe('S1');
    expect(alert.informedEntity?.[2]?.agencyId).toBe('A1');
  });

  it('falls back to UNKNOWN for unrecognized enum strings', () => {
    const alert = toAlert({ ...base, cause: 'NOPE', effect: 'NOPE', severity_level: 'NOPE' });
    expect(alert.cause).toBe(transit_realtime.Alert.Cause.UNKNOWN_CAUSE);
    expect(alert.effect).toBe(transit_realtime.Alert.Effect.UNKNOWN_EFFECT);
    expect(alert.severityLevel).toBe(transit_realtime.Alert.SeverityLevel.UNKNOWN_SEVERITY);
  });

  it('FeedMessage round-trips through encode/decode (v2.0 FULL_DATASET)', () => {
    const msg = buildFeedMessage([base], { timestamp: 1717000000 });
    const decoded = decodeFeedMessage(encodeFeedMessage(msg));
    expect(decoded.header?.gtfsRealtimeVersion).toBe('2.0');
    expect(Number(decoded.header?.incrementality)).toBe(transit_realtime.FeedHeader.Incrementality.FULL_DATASET);
    expect(Number(decoded.header?.timestamp)).toBe(1717000000);
    expect(decoded.entity).toHaveLength(1);
    expect(decoded.entity?.[0]?.id).toBe('a1');
    expect(decoded.entity?.[0]?.alert?.headerText?.translation?.[0]?.text).toBe('Detour');
  });
});

describe('active_period filtering', () => {
  it('no periods → always active', () => expect(isAlertActiveAt([], 100)).toBe(true));
  it('within an open-ended start window', () => expect(isAlertActiveAt([{ start: 50 }], 100)).toBe(true));
  it('within a closed window', () => expect(isAlertActiveAt([{ start: 50, end: 150 }], 100)).toBe(true));
  it('before the window', () => expect(isAlertActiveAt([{ start: 200 }], 100)).toBe(false));
  it('after the window (end is exclusive)', () => expect(isAlertActiveAt([{ end: 100 }], 100)).toBe(false));
});

// ─── Authoring API ─────────────────────────────────────────────────────────────

describe('alerts CRUD + gating', () => {
  it('creates, edits, activates, and deletes an alert', async () => {
    const client = await loggedIn('agency-author@example.com');
    const proj = await createProject(client, 'Feed');

    const created = await client.json<{ alert: { id: string; status: string }; warnings: string[] }>(
      await client.post(`/api/projects/${proj.id}/alerts`, ACTIVE_ALERT),
    );
    expect(created.alert.status).toBe('active');
    const alertId = created.alert.id;

    const list1 = await client.json<{ alerts: unknown[] }>(await client.get(`/api/projects/${proj.id}/alerts`));
    expect(list1.alerts).toHaveLength(1);

    const edited = await client.json<{ alert: { header_text: string } }>(
      await client.put(`/api/projects/${proj.id}/alerts/${alertId}`, { ...ACTIVE_ALERT, header_text: 'Updated header' }),
    );
    expect(edited.alert.header_text).toBe('Updated header');

    const patched = await client.json<{ alert: { status: string } }>(
      await client.patch(`/api/projects/${proj.id}/alerts/${alertId}`, { status: 'draft' }),
    );
    expect(patched.alert.status).toBe('draft');

    const del = await client.delete(`/api/projects/${proj.id}/alerts/${alertId}`);
    expect(del.status).toBe(204);
    const list2 = await client.json<{ alerts: unknown[] }>(await client.get(`/api/projects/${proj.id}/alerts`));
    expect(list2.alerts).toHaveLength(0);
  });

  it('rejects a non-owner with 404 (cross-user isolation)', async () => {
    const owner = await loggedIn('owner@example.com');
    const proj = await createProject(owner, 'Owned');
    const intruder = await loggedIn('intruder@example.com');
    const res = await intruder.post(`/api/projects/${proj.id}/alerts`, ACTIVE_ALERT);
    expect(res.status).toBe(404);
  });

  it('paywalls Free users (402)', async () => {
    const free = await loggedIn('free-user@example.com', 'free');
    const proj = await createProject(free, 'Free Feed');
    const res = await free.post(`/api/projects/${proj.id}/alerts`, ACTIVE_ALERT);
    expect(res.status).toBe(402);
  });

  it('validates header, informed_entity, and period ordering', async () => {
    const client = await loggedIn('validation@example.com');
    const proj = await createProject(client, 'V');
    // validationFailed → 422 Unprocessable Entity.
    expect((await client.post(`/api/projects/${proj.id}/alerts`, { ...ACTIVE_ALERT, header_text: '' })).status).toBe(422);
    expect((await client.post(`/api/projects/${proj.id}/alerts`, { ...ACTIVE_ALERT, informed_entities: [] })).status).toBe(422);
    expect(
      (await client.post(`/api/projects/${proj.id}/alerts`, { ...ACTIVE_ALERT, active_periods: [{ start: 100, end: 50 }] })).status,
    ).toBe(422);
  });
});

// ─── Public serving ────────────────────────────────────────────────────────────

describe('serving /<slug>/alerts.pb and .json', () => {
  it('serves an active alert as decodable protobuf + JSON mirror', async () => {
    const client = await loggedIn('serve@example.com');
    const proj = await createProject(client, 'Served');
    await client.post(`/api/projects/${proj.id}/alerts`, ACTIVE_ALERT);
    await publish(proj.id, proj.slug);

    const pb = await SELF.fetch(`http://feeds.example.com/${proj.slug}/alerts.pb`);
    expect(pb.status).toBe(200);
    expect(pb.headers.get('content-type')).toBe('application/x-protobuf');
    expect(pb.headers.get('cache-control')).toContain('max-age=30');
    const msg = decodeFeedMessage(new Uint8Array(await pb.arrayBuffer()));
    expect(msg.entity).toHaveLength(1);
    expect(msg.entity?.[0]?.alert?.headerText?.translation?.[0]?.text).toBe('Route 5 detour around Main St');

    const json = await SELF.fetch(`http://feeds.example.com/${proj.slug}/alerts.json`);
    expect(json.status).toBe(200);
    const body = await json.json<{ entity: { alert: { headerText: { translation: { text: string }[] } } }[] }>();
    expect(body.entity[0].alert.headerText.translation[0].text).toBe('Route 5 detour around Main St');
  });

  it('excludes drafts and expired alerts', async () => {
    const client = await loggedIn('drafts@example.com');
    const proj = await createProject(client, 'Drafts');
    await client.post(`/api/projects/${proj.id}/alerts`, { ...ACTIVE_ALERT, status: 'draft' });
    await client.post(`/api/projects/${proj.id}/alerts`, { ...ACTIVE_ALERT, active_periods: [{ start: 1, end: 2 }] });
    await publish(proj.id, proj.slug);

    const pb = await SELF.fetch(`http://feeds.example.com/${proj.slug}/alerts.pb`);
    const msg = decodeFeedMessage(new Uint8Array(await pb.arrayBuffer()));
    expect(msg.entity ?? []).toHaveLength(0);
  });

  it('is project-scoped — one project\'s alerts never serve under another\'s slug', async () => {
    const client = await loggedIn('iso@example.com');
    const projA = await createProject(client, 'Alpha');
    const projB = await createProject(client, 'Bravo');
    await client.post(`/api/projects/${projA.id}/alerts`, ACTIVE_ALERT);
    await publish(projA.id, projA.slug);
    await publish(projB.id, projB.slug);

    const a = decodeFeedMessage(new Uint8Array(await (await SELF.fetch(`http://feeds.example.com/${projA.slug}/alerts.pb`)).arrayBuffer()));
    const b = decodeFeedMessage(new Uint8Array(await (await SELF.fetch(`http://feeds.example.com/${projB.slug}/alerts.pb`)).arrayBuffer()));
    expect(a.entity).toHaveLength(1);
    expect(b.entity ?? []).toHaveLength(0);
  });

  it('404s for an unpublished slug', async () => {
    const res = await SELF.fetch('http://feeds.example.com/no-such-feed/alerts.pb');
    expect(res.status).toBe(404);
  });
});

// ─── RT coexistence (Option A) ───────────────────────────────────────────────────

describe('RT coexistence: managed project_rt_feed', () => {
  async function rtRows(projectId: string) {
    const res = await testEnv.DB.prepare(
      `SELECT kind, url, managed FROM project_rt_feed WHERE project_id = ?`,
    )
      .bind(projectId)
      .all<{ kind: string; url: string; managed: number }>();
    return res.results ?? [];
  }

  it('auto-wires a managed alerts feed on create and removes it when the last alert is deleted', async () => {
    const client = await loggedIn('coexist@example.com');
    const proj = await createProject(client, 'Coexist');

    const created = await client.json<{ alert: { id: string }; rt_coexistence: { managed_feed_url: string | null } }>(
      await client.post(`/api/projects/${proj.id}/alerts`, ACTIVE_ALERT),
    );
    expect(created.rt_coexistence.managed_feed_url).toMatch(new RegExp(`/${proj.slug}/alerts\\.pb$`));

    const rows = await rtRows(proj.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'alerts', managed: 1 });

    // The external-feed editor must not see the managed row.
    const ext = await client.json<{ feeds: unknown[] }>(await client.get(`/api/projects/${proj.id}/rt-feeds`));
    expect(ext.feeds).toHaveLength(0);

    await client.delete(`/api/projects/${proj.id}/alerts/${created.alert.id}`);
    expect(await rtRows(proj.id)).toHaveLength(0);
  });

  it('never wires two alerts feeds — surfaces a conflict, resolved by adopting ours', async () => {
    const client = await loggedIn('conflict@example.com');
    const proj = await createProject(client, 'Conflict');
    // Register an external alerts feed first.
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'alerts', url: 'https://external.example.com/alerts.pb' }],
    });

    const created = await client.json<{ rt_coexistence: { managed_feed_url: string | null; external_alerts_feed: { url: string } | null } }>(
      await client.post(`/api/projects/${proj.id}/alerts`, ACTIVE_ALERT),
    );
    expect(created.rt_coexistence.managed_feed_url).toBeNull();
    expect(created.rt_coexistence.external_alerts_feed?.url).toBe('https://external.example.com/alerts.pb');

    const adopted = await client.json<{ rt_coexistence: { managed_feed_url: string | null; external_alerts_feed: unknown } }>(
      await client.post(`/api/projects/${proj.id}/alerts/rt-feed`, { resolution: 'replace_external' }),
    );
    expect(adopted.rt_coexistence.external_alerts_feed).toBeNull();
    expect(adopted.rt_coexistence.managed_feed_url).toMatch(new RegExp(`/${proj.slug}/alerts\\.pb$`));
  });
});
