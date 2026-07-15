// Agency NTD IDs (agency.external_id) → feed_info.json + dmfr.json, and the
// agency_id-churn publish warning.
//
// Background: FTA proposed requiring agency_id == NTD ID, withdrew it (July
// 2025), and now crosswalks published feeds → NTD IDs itself via the enhanced
// P-50 form. The NTD ID lives on the AGENCY, inside the feed — `external_id`,
// an optional custom column on agency.txt — so it rides along in the snapshot
// state and needs no project-level column. The publication endpoints project it
// out per agency: feed_info.json's `agencies[]`, and one DMFR operator per
// agency carrying `tags.us_ntd_id` + `associated_feeds[].gtfs_agency_id`. We
// also warn when a publish would churn the agency_id values that crosswalk is
// keyed on.
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

interface StateAgency {
  agency_id: string;
  agency_name?: string;
  /** The agency's NTD ID — a string; leading zeros are significant. */
  external_id?: string;
}

interface FeedState {
  feedInfo?: Record<string, string>;
  agencies?: StateAgency[];
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
  licenseSpdx?: string | null;
  /** Only used by the "publish no longer accepts ntdId" test. */
  ntdId?: string;
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

/** The same feed with an NTD ID on each agency (leading zeros on purpose). */
function stateWithNtdIds(): FeedState {
  return sampleState({
    agencies: [
      { agency_id: 'SVT', agency_name: 'Sunset Valley Transit', external_id: '00123' },
      { agency_id: 'RRT', agency_name: 'River Ridge Transit', external_id: '04567' },
    ],
  });
}

interface DmfrDoc {
  license_spdx_identifier?: string;
  feeds: Array<{
    id: string;
    spec: string;
    name?: string;
    urls: Record<string, string>;
    license?: { spdx_identifier: string };
    tags?: Record<string, string>;
    operators?: Array<{
      onestop_id: string;
      name: string;
      associated_feeds?: Array<{ gtfs_agency_id?: string }>;
      tags?: Record<string, string>;
    }>;
  }>;
}

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

describe('agency NTD IDs (external_id) + DMFR + agency_id churn', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  // ─── Publish contract: license only; no project-level NTD ID ────────────────

  it('publish persists licenseSpdx and no longer accepts or persists a project-level ntdId', async () => {
    const client = await loggedInClient('ntd1@example.com');
    const proj = await createProject(client, 'NTD One');
    const snap = await createSnapshot(client, proj.id, stateWithNtdIds());

    // ntdId is sent to prove it is inert — the project record has no such field
    // and the publish must still succeed (the ID lives on the agency now).
    const res = await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, {
      licenseSpdx: 'CC-BY-4.0',
      ntdId: '00123',
    });
    expect(res.status).toBe(200);

    const project = await client.json<Record<string, unknown>>(await client.get(`/api/projects/${proj.id}`));
    expect(project.licenseSpdx).toBe('CC-BY-4.0');
    expect('ntdId' in project).toBe(false);
  });

  // ─── feed_info.json sidecar: per-agency projection ──────────────────────────

  it('feed_info.json lists every agency with its external_id (leading zeros intact)', async () => {
    const client = await loggedInClient('ntd3@example.com');

    const proj = await createProject(client, 'With NTD');
    const snap = await createSnapshot(client, proj.id, stateWithNtdIds());
    expect(
      (await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, { licenseSpdx: 'CC0-1.0' })).status,
    ).toBe(200);

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/feed_info.json`);
    expect(res.status).toBe(200);
    const body = await res.json<{
      agencies: Array<Record<string, string>>;
      license_spdx_identifier?: string;
    }>();

    expect(body.agencies).toEqual([
      { agency_id: 'SVT', agency_name: 'Sunset Valley Transit', external_id: '00123' },
      { agency_id: 'RRT', agency_name: 'River Ridge Transit', external_id: '04567' },
    ]);
    // A string all the way through — a number would give 123.
    expect(typeof body.agencies[0].external_id).toBe('string');
    expect(body.license_spdx_identifier).toBe('CC0-1.0');
    // The old project-level key is gone for good.
    expect('ntd_id' in body).toBe(false);
  });

  it('feed_info.json omits external_id on agencies that have none, and license when unset', async () => {
    const client = await loggedInClient('ntd3b@example.com');
    const proj = await createProject(client, 'Mixed NTD');
    const snap = await createSnapshot(
      client,
      proj.id,
      sampleState({
        agencies: [
          { agency_id: 'SVT', agency_name: 'Sunset Valley Transit', external_id: '00123' },
          { agency_id: 'RRT', agency_name: 'River Ridge Transit' },
        ],
      }),
    );
    expect((await publishMultipart(client, proj.id, snap.snapshot.id, ZIP)).status).toBe(200);

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/feed_info.json`);
    const body = await res.json<{ agencies: Array<Record<string, string>>; license_spdx_identifier?: string }>();

    expect(body.agencies).toHaveLength(2);
    expect(body.agencies[0].external_id).toBe('00123');
    // Absent, not an explicit null.
    expect('external_id' in body.agencies[1]).toBe(false);
    expect('license_spdx_identifier' in body).toBe(false);
  });

  // ─── dmfr.json: one operator per agency ─────────────────────────────────────

  it('dmfr.json emits one operator per agency, each with its own NTD ID + gtfs_agency_id', async () => {
    const client = await loggedInClient('ntd4@example.com');
    const proj = await createProject(client, 'DMFR Feed');
    const snap = await createSnapshot(client, proj.id, stateWithNtdIds());
    expect(
      (await publishMultipart(client, proj.id, snap.snapshot.id, ZIP, { licenseSpdx: 'CC-BY-4.0' })).status,
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
    const doc = await res.json<DmfrDoc>();

    // THE assertion: the real schema, not a field checklist.
    expectValidDmfr(doc);

    const gtfs = doc.feeds.find((f) => f.spec === 'gtfs');
    expect(gtfs).toBeDefined();
    expect(gtfs!.urls.static_current).toBe(`http://feeds.test.local/${proj.slug}/gtfs.zip`);
    expect(gtfs!.license?.spdx_identifier).toBe('CC-BY-4.0');
    expect(doc.license_spdx_identifier).toBe('CC-BY-4.0');

    // Two agencies → two operators, each with its OWN crosswalk. This is what
    // the old single project-level NTD ID could not express.
    const operators = gtfs!.operators ?? [];
    expect(operators).toHaveLength(2);

    const svt = operators.find((o) => o.name === 'Sunset Valley Transit')!;
    const rrt = operators.find((o) => o.name === 'River Ridge Transit')!;
    expect(svt.tags?.us_ntd_id).toBe('00123');
    expect(rrt.tags?.us_ntd_id).toBe('04567');
    expect(svt.associated_feeds).toEqual([{ gtfs_agency_id: 'SVT' }]);
    expect(rrt.associated_feeds).toEqual([{ gtfs_agency_id: 'RRT' }]);
    // Derived Onestop ID: o-<geohash>-<agency name> (see worker/publication/dmfr.ts).
    expect(svt.onestop_id).toMatch(/^o-[0-9b-hjkmnp-z]{4}-sunsetvalleytransit$/);
    expect(rrt.onestop_id).toMatch(/^o-[0-9b-hjkmnp-z]{4}-riverridgetransit$/);
    // No feed-level fallback tag when operators carry the IDs.
    expect(gtfs!.tags).toBeUndefined();

    const rt = doc.feeds.find((f) => f.spec === 'gtfs-rt');
    expect(rt).toBeDefined();
    expect(rt!.urls).toEqual({
      realtime_trip_updates: 'https://example.com/tu.pb',
      realtime_vehicle_positions: 'https://example.com/vp.pb',
      realtime_alerts: 'https://example.com/alerts.pb',
    });
  });

  it('dmfr.json: an agency with no external_id gets an operator with no tags', async () => {
    const client = await loggedInClient('ntd4b@example.com');
    const proj = await createProject(client, 'Partial NTD');
    const snap = await createSnapshot(
      client,
      proj.id,
      sampleState({
        agencies: [
          { agency_id: 'SVT', agency_name: 'Sunset Valley Transit', external_id: '00123' },
          { agency_id: 'RRT', agency_name: 'River Ridge Transit' },
        ],
      }),
    );
    expect((await publishMultipart(client, proj.id, snap.snapshot.id, ZIP)).status).toBe(200);

    const doc = await (await SELF.fetch(`http://feeds.example.com/${proj.slug}/dmfr.json`)).json<DmfrDoc>();
    expectValidDmfr(doc);

    const operators = doc.feeds[0].operators ?? [];
    expect(operators).toHaveLength(2);
    const rrt = operators.find((o) => o.name === 'River Ridge Transit')!;
    expect(rrt.tags).toBeUndefined();
    expect(rrt.associated_feeds).toEqual([{ gtfs_agency_id: 'RRT' }]);
    // The agency that DOES have one still carries it.
    expect(operators.find((o) => o.name === 'Sunset Valley Transit')!.tags?.us_ntd_id).toBe('00123');
  });

  it('dmfr.json is valid with no NTD IDs, no license, and no RT feeds', async () => {
    const client = await loggedInClient('ntd5@example.com');
    const proj = await createProject(client, 'Bare Feed');
    const snap = await createSnapshot(client, proj.id, sampleState());
    expect((await publishMultipart(client, proj.id, snap.snapshot.id, ZIP)).status).toBe(200);

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/dmfr.json`);
    expect(res.status).toBe(200);
    const doc = await res.json<DmfrDoc>();
    expectValidDmfr(doc);
    expect(doc.feeds).toHaveLength(1); // no gtfs-rt entry without RT feeds
    expect(doc.feeds[0].spec).toBe('gtfs');
    expect('license_spdx_identifier' in doc).toBe(false);
    // Operators still emitted (names + geohash are derivable), carrying no tags.
    const operators = doc.feeds[0].operators ?? [];
    expect(operators).toHaveLength(2);
    expect(operators.every((o) => o.tags === undefined)).toBe(true);
  });

  it('dmfr.json: with no stop coordinates, a single NTD ID falls back to a feed-level tag', async () => {
    const client = await loggedInClient('ntd6@example.com');

    // One agency with an ID → unambiguous, so the crosswalk survives on the feed.
    const one = await createProject(client, 'No Geo One');
    const s1 = await createSnapshot(
      client,
      one.id,
      sampleState({
        agencies: [{ agency_id: 'SVT', agency_name: 'Sunset Valley Transit', external_id: '00123' }],
        stops: [],
      }),
    );
    expect((await publishMultipart(client, one.id, s1.snapshot.id, ZIP)).status).toBe(200);

    const doc1 = await (await SELF.fetch(`http://feeds.example.com/${one.slug}/dmfr.json`)).json<DmfrDoc>();
    expectValidDmfr(doc1);
    expect(doc1.feeds[0].operators).toBeUndefined(); // no geohash → no Onestop ID
    expect(doc1.feeds[0].tags).toEqual({ us_ntd_id: '00123' });

    // Two agencies with IDs → a feed-level tag cannot say which one, so omit it.
    const two = await createProject(client, 'No Geo Two');
    const s2 = await createSnapshot(client, two.id, { ...stateWithNtdIds(), stops: [] });
    expect((await publishMultipart(client, two.id, s2.snapshot.id, ZIP)).status).toBe(200);

    const doc2 = await (await SELF.fetch(`http://feeds.example.com/${two.slug}/dmfr.json`)).json<DmfrDoc>();
    expectValidDmfr(doc2);
    expect(doc2.feeds[0].operators).toBeUndefined();
    expect(doc2.feeds[0].tags).toBeUndefined();
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
