// NTD ID → publication → feed_info.json + dmfr.json, and the agency_id-churn
// publish warning.
//
// Background: FTA proposed requiring agency_id == NTD ID, withdrew it (July
// 2025), and now crosswalks published feeds → NTD IDs itself via the enhanced
// P-50 form. We carry the NTD ID through publication and emit a DMFR document
// so publishers land in Transitland / Mobility Database pipelines with the
// crosswalk intact — and we warn when a publish would churn the agency_id
// values that crosswalk is keyed on.
//
// The DMFR assertion validates the emitted document against the REAL DMFR
// v0.5.1 JSON schema (vendored verbatim from transitland/
// distributed-mobility-feed-registry), not against a hand-written field list.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import Ajv, { type ValidateFunction } from 'ajv';
import dmfrSchema from './fixtures/dmfr.schema-v0.5.1.json';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

const ajv = new Ajv({ strict: false, allErrors: true });
const validateDmfr: ValidateFunction = ajv.compile(dmfrSchema);

function expectValidDmfr(doc: unknown): void {
  const ok = validateDmfr(doc);
  if (!ok) {
    throw new Error(
      `DMFR document failed dmfr.schema-v0.5.1.json:\n${JSON.stringify(validateDmfr.errors, null, 2)}\n` +
        `Document:\n${JSON.stringify(doc, null, 2)}`,
    );
  }
}

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

interface FeedState {
  feedInfo?: Record<string, string>;
  ntdId?: string | null;
  agencies?: Array<{ agency_id: string; agency_name?: string }>;
  routes?: Array<{ route_id: string }>;
  stops?: Array<{ stop_id: string; stop_lat?: number; stop_lon?: number }>;
  trips?: Array<{ trip_id: string }>;
}

async function createSnapshot(
  client: TestClient,
  projectId: string,
  state: FeedState,
): Promise<{ snapshot: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.json(await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }));
}

interface PublishFlags {
  ignoreRtBreakage?: boolean;
  ignoreAgencyChurn?: boolean;
  ntdId?: string | null;
  licenseSpdx?: string | null;
}

async function publishMultipart(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  zipBytes: Uint8Array,
  flags: PublishFlags = {},
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, ...flags }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

/** A minimal but realistic feed: two agencies, stops with coordinates. */
function sampleState(overrides: Partial<FeedState> = {}): FeedState {
  return {
    feedInfo: { feed_publisher_name: 'Sunset Valley Transit' },
    agencies: [
      { agency_id: 'SVT', agency_name: 'Sunset Valley Transit' },
      { agency_id: 'RRT', agency_name: 'River Ridge Transit' },
    ],
    routes: [{ route_id: 'R1' }],
    stops: [
      { stop_id: 'S1', stop_lat: 45.68, stop_lon: -111.04 },
      { stop_id: 'S2', stop_lat: 45.7, stop_lon: -111.02 },
    ],
    trips: [{ trip_id: 'T1' }],
    ...overrides,
  };
}

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

describe('NTD ID + DMFR + agency_id churn', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  // ─── A2: publish carries ntdId + licenseSpdx onto feed_project ──────────────

  it('publish persists ntdId + licenseSpdx, preserving leading zeros', async () => {
    const client = await loggedInClient('ntd1@example.com');
    const proj = await createProject(client, 'NTD One');
    const snap = await createSnapshot(client, proj.id, sampleState({ ntdId: '00123' }));

    const res = await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, {
      ntdId: '00123',
      licenseSpdx: 'CC-BY-4.0',
    });
    expect(res.status).toBe(200);

    const project = await client.json<{ ntdId: string | null; licenseSpdx: string | null }>(
      await client.get(`/api/projects/${proj.id}`),
    );
    // A string all the way through — an int column/parse would give "123".
    expect(project.ntdId).toBe('00123');
    expect(typeof project.ntdId).toBe('string');
    expect(project.licenseSpdx).toBe('CC-BY-4.0');
  });

  it('rejects a non-numeric / oversized NTD ID (422)', async () => {
    const client = await loggedInClient('ntd2@example.com');
    const proj = await createProject(client, 'NTD Two');
    const snap = await createSnapshot(client, proj.id, sampleState());

    const bad = await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, { ntdId: 'ABC12' });
    expect(bad.status).toBe(422);

    const tooLong = await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, { ntdId: '123456' });
    expect(tooLong.status).toBe(422);
  });

  // ─── A4: feed_info.json sidecar ─────────────────────────────────────────────

  it('feed_info.json includes ntd_id + license_spdx_identifier, and omits them when unset', async () => {
    const client = await loggedInClient('ntd3@example.com');

    const withNtd = await createProject(client, 'With NTD');
    const s1 = await createSnapshot(client, withNtd.id, sampleState({ ntdId: '00123' }));
    expect(
      (await publishMultipart(client, withNtd.id, s1.snapshot.id, ZIP, {
        ntdId: '00123',
        licenseSpdx: 'CC0-1.0',
      })).status,
    ).toBe(200);

    const res = await SELF.fetch(`http://feeds.example.com/${withNtd.slug}/feed_info.json`);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.ntd_id).toBe('00123');
    expect(body.license_spdx_identifier).toBe('CC0-1.0');

    // …and a feed with neither set omits the keys entirely (no explicit nulls).
    const without = await createProject(client, 'Without NTD');
    const s2 = await createSnapshot(client, without.id, sampleState());
    expect((await publishMultipart(client, without.id, s2.snapshot.id, ZIP)).status).toBe(200);

    const res2 = await SELF.fetch(`http://feeds.example.com/${without.slug}/feed_info.json`);
    const body2 = await res2.json<Record<string, unknown>>();
    expect('ntd_id' in body2).toBe(false);
    expect('license_spdx_identifier' in body2).toBe(false);
  });

  // ─── A5: dmfr.json ──────────────────────────────────────────────────────────

  it('dmfr.json validates against the real DMFR v0.5.1 schema and carries the NTD crosswalk', async () => {
    const client = await loggedInClient('ntd4@example.com');
    const proj = await createProject(client, 'DMFR Feed');
    const snap = await createSnapshot(client, proj.id, sampleState({ ntdId: '00123' }));
    expect(
      (await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, {
        ntdId: '00123',
        licenseSpdx: 'CC-BY-4.0',
      })).status,
    ).toBe(200);

    // Register RT feeds so the companion gtfs-rt entry is exercised too.
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [
        { kind: 'trip_updates', url: 'https://example.com/tu.pb' },
        { kind: 'vehicle_positions', url: 'https://example.com/vp.pb' },
        { kind: 'alerts', url: 'https://example.com/alerts.pb' },
      ],
    });

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/dmfr.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const doc = await res.json<{
      license_spdx_identifier?: string;
      feeds: Array<{
        id: string;
        spec: string;
        name?: string;
        urls: Record<string, string>;
        license?: { spdx_identifier: string };
        operators?: Array<{ onestop_id: string; name: string; tags?: Record<string, string> }>;
      }>;
    }>();

    // THE assertion: the real schema, not a field checklist.
    expectValidDmfr(doc);

    const gtfs = doc.feeds.find((f) => f.spec === 'gtfs');
    expect(gtfs).toBeDefined();
    expect(gtfs!.urls.static_current).toBe(`http://feeds.test.local/${proj.slug}/gtfs.zip`);
    expect(gtfs!.license?.spdx_identifier).toBe('CC-BY-4.0');
    expect(doc.license_spdx_identifier).toBe('CC-BY-4.0');

    // The whole point: the NTD crosswalk rides on the operator tag Transitland
    // already uses (us_ntd_id), as a string with its leading zeros.
    const operator = gtfs!.operators?.[0];
    expect(operator).toBeDefined();
    expect(operator!.tags?.us_ntd_id).toBe('00123');
    expect(operator!.name).toBe('Sunset Valley Transit');
    // Derived Onestop ID: o-<geohash>-<name> (see worker/publication/dmfr.ts).
    expect(operator!.onestop_id).toMatch(/^o-[0-9b-hjkmnp-z]{4}-sunsetvalleytransit$/);

    const rt = doc.feeds.find((f) => f.spec === 'gtfs-rt');
    expect(rt).toBeDefined();
    expect(rt!.urls).toEqual({
      realtime_trip_updates: 'https://example.com/tu.pb',
      realtime_vehicle_positions: 'https://example.com/vp.pb',
      realtime_alerts: 'https://example.com/alerts.pb',
    });
  });

  it('dmfr.json is valid with no NTD ID, no license, and no RT feeds', async () => {
    const client = await loggedInClient('ntd5@example.com');
    const proj = await createProject(client, 'Bare Feed');
    const snap = await createSnapshot(client, proj.id, sampleState());
    expect((await publishMultipart(client, proj.id, snap.snapshot.id, ZIP)).status).toBe(200);

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/dmfr.json`);
    expect(res.status).toBe(200);
    const doc = await res.json<{ feeds: Array<{ spec: string; operators?: unknown[] }>; license_spdx_identifier?: string }>();
    expectValidDmfr(doc);
    expect(doc.feeds).toHaveLength(1); // no gtfs-rt entry without RT feeds
    expect(doc.feeds[0].spec).toBe('gtfs');
    expect('license_spdx_identifier' in doc).toBe(false);
    // Operator still emitted (name + geohash are derivable) but carries no tags.
    expect(doc.feeds[0].operators).toHaveLength(1);
  });

  it('dmfr.json 404s for an unpublished slug', async () => {
    const res = await SELF.fetch('http://feeds.example.com/no-such-feed/dmfr.json');
    expect(res.status).toBe(404);
  });

  // ─── C2: agency_id churn warning (applies with NO RT feeds registered) ──────

  it('removing an agency_id → 409 agency_id_churn with no RT feeds registered', async () => {
    const client = await loggedInClient('churn1@example.com');
    const proj = await createProject(client, 'Churn One');

    const vOld = await createSnapshot(client, proj.id, sampleState());
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);

    // Drop RRT. No RT feeds are registered — the old rt_breakage gate would
    // never have fired here; the churn gate must.
    const vNew = await createSnapshot(
      client,
      proj.id,
      sampleState({ agencies: [{ agency_id: 'SVT', agency_name: 'Sunset Valley Transit' }] }),
    );

    const blocked = await publishMultipart(client, proj.id, vNew.snapshot.id, ZIP);
    expect(blocked.status).toBe(409);
    const body = await blocked.json<{ error: string; message: string; removed: { agencies: string[] } }>();
    expect(body.error).toBe('agency_id_churn');
    expect(body.removed.agencies).toEqual(['RRT']);
    expect(body.message).toMatch(/P-50/);

    // Acknowledged → goes through.
    const allowed = await publishMultipart(client, proj.id, vNew.snapshot.id, ZIP, {
      ignoreAgencyChurn: true,
    });
    expect(allowed.status).toBe(200);
  });

  it('a publish with no agency_id churn does not 409', async () => {
    const client = await loggedInClient('churn2@example.com');
    const proj = await createProject(client, 'Churn Two');

    const vOld = await createSnapshot(client, proj.id, sampleState());
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);

    // Same agency_ids; a route is added and an agency renamed — neither is churn.
    const vNew = await createSnapshot(
      client,
      proj.id,
      sampleState({
        agencies: [
          { agency_id: 'SVT', agency_name: 'Sunset Valley Transit Authority' },
          { agency_id: 'RRT', agency_name: 'River Ridge Transit' },
        ],
        routes: [{ route_id: 'R1' }, { route_id: 'R2' }],
      }),
    );
    const res = await publishMultipart(client, proj.id, vNew.snapshot.id, ZIP);
    expect(res.status).toBe(200);
  });

  it('first publish never trips the churn gate', async () => {
    const client = await loggedInClient('churn3@example.com');
    const proj = await createProject(client, 'Churn Three');
    const snap = await createSnapshot(client, proj.id, sampleState());
    expect((await publishMultipart(client, proj.id, snap.snapshot.id, ZIP)).status).toBe(200);
  });

  it('rt_breakage is still checked first when both gates would fire', async () => {
    const client = await loggedInClient('churn4@example.com');
    const proj = await createProject(client, 'Churn Four');

    const vOld = await createSnapshot(client, proj.id, sampleState());
    expect((await publishMultipart(client, proj.id, vOld.snapshot.id, ZIP)).status).toBe(200);

    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'trip_updates', url: 'https://example.com/tu.pb' }],
    });

    // Drops an agency AND a stop → both gates would fire; rt_breakage wins.
    const vNew = await createSnapshot(
      client,
      proj.id,
      sampleState({
        agencies: [{ agency_id: 'SVT', agency_name: 'Sunset Valley Transit' }],
        stops: [{ stop_id: 'S1', stop_lat: 45.68, stop_lon: -111.04 }],
      }),
    );

    const blocked = await publishMultipart(client, proj.id, vNew.snapshot.id, ZIP);
    expect(blocked.status).toBe(409);
    expect((await blocked.json<{ error: string }>()).error).toBe('rt_breakage');

    // Acking only the RT gate falls through to the churn gate — the user has to
    // acknowledge the NTD-crosswalk break too.
    const stillBlocked = await publishMultipart(client, proj.id, vNew.snapshot.id, ZIP, {
      ignoreRtBreakage: true,
    });
    expect(stillBlocked.status).toBe(409);
    expect((await stillBlocked.json<{ error: string }>()).error).toBe('agency_id_churn');

    const allowed = await publishMultipart(client, proj.id, vNew.snapshot.id, ZIP, {
      ignoreRtBreakage: true,
      ignoreAgencyChurn: true,
    });
    expect(allowed.status).toBe(200);
  });
});
