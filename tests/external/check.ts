/**
 * External-API contract checks for GTFS·X.
 *
 * Hits the real third-party APIs that the editor depends on and asserts a
 * sane response shape. Run on a daily cron from .github/workflows/external-apis.yml
 * (and on push when demographics.ts / snapToRoad.ts change). Failures email
 * the repo collaborators via GitHub's default workflow-failure notifications.
 *
 * Triggered the original problem this catches: Census added a key requirement
 * in early 2026 and silently 401'd anonymous requests. Mocked unit tests
 * couldn't see that change. This file does.
 *
 * Usage:
 *   CENSUS_API_KEY=... MAPBOX_TOKEN=... npx tsx tests/external/check.ts
 *
 * Each check is independent — one failure does not skip the others. The
 * process exits non-zero if any check fails so CI marks the run red.
 */

const CENSUS_API_KEY = process.env.CENSUS_API_KEY ?? '';
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN ?? '';

// Known-good fixture: Gallatin County, Montana (state 30, county 031) —
// Bozeman's home county. The bundled streamline feed lives here, so any
// shape change in Census or FCC responses will affect a real user flow.
const FIXTURE = {
  stateFips: '30',
  countyFips: '031',
  lat: 45.6796, // downtown Bozeman
  lon: -111.0444,
} as const;

interface Check {
  name: string;
  fn: () => Promise<void>;
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

// Lazy error-body helper — `await res.text()` consumes the body, so we
// must not call it eagerly inside assert messages.
async function httpBody(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); }
  catch { return ''; }
}

async function run(check: Check) {
  process.stdout.write(`  ${check.name} ... `);
  try {
    await check.fn();
    console.log('OK');
    results.push({ name: check.name, ok: true, detail: '' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`FAIL — ${detail}`);
    results.push({ name: check.name, ok: false, detail });
  }
}

const checks: Check[] = [
  {
    name: 'Census ACS5 — block-group query with API key',
    async fn() {
      assert(CENSUS_API_KEY, 'CENSUS_API_KEY env var is not set; add as a GitHub Actions secret');
      const url =
        `https://api.census.gov/data/2022/acs/acs5` +
        `?get=B01003_001E,B25001_001E,B08301_001E,B03002_001E,B03002_003E` +
        `&for=block%20group:*&in=state:${FIXTURE.stateFips}` +
        `&in=county:${FIXTURE.countyFips}&in=tract:*` +
        `&key=${encodeURIComponent(CENSUS_API_KEY)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await httpBody(res)}`);
      const data = await res.json();
      assert(Array.isArray(data), `expected array response, got ${typeof data}`);
      assert(data.length > 1, `expected header + ≥1 row, got ${data.length}`);
      // Header sanity — columns must still exist and be in the order the
      // editor parses by index.
      const header = data[0] as string[];
      assert(header[0] === 'B01003_001E', `expected B01003_001E in col 0, got ${header[0]}`);
      assert(header[3] === 'B03002_001E', `expected B03002_001E in col 3, got ${header[3]}`);
      assert(header[4] === 'B03002_003E', `expected B03002_003E in col 4, got ${header[4]}`);
      // Geo cols at the tail end.
      assert(header.includes('state'), 'missing "state" column');
      assert(header.includes('county'), 'missing "county" column');
      assert(header.includes('tract'), 'missing "tract" column');
      assert(header.includes('block group'), 'missing "block group" column');
    },
  },
  {
    name: 'Census tract centroids — bundled file is still served',
    async fn() {
      // The editor fetches `${BASE_URL}census/TR<state>.txt` from its own
      // origin (bundled in public/census/). External contract from us, not
      // from Census — but worth catching if the build dropped the file.
      const path = `public/census/TR${FIXTURE.stateFips}.txt`;
      const { existsSync, statSync } = await import('node:fs');
      assert(existsSync(path), `tract centroid file missing: ${path}`);
      const size = statSync(path).size;
      assert(size > 1_000, `tract centroid file unexpectedly small: ${size} bytes`);
    },
  },
  {
    name: 'FCC Area API — lat/lon → state+county FIPS',
    async fn() {
      const res = await fetch(
        `https://geo.fcc.gov/api/census/area?lat=${FIXTURE.lat}&lon=${FIXTURE.lon}&format=json`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await httpBody(res)}`);
      const data = await res.json();
      const result = data.results?.[0];
      assert(result, 'no results in FCC response');
      assert(typeof result.state_fips === 'string', `state_fips type: ${typeof result.state_fips}`);
      assert(typeof result.county_fips === 'string', `county_fips type: ${typeof result.county_fips}`);
      assert(
        result.state_fips === FIXTURE.stateFips,
        `expected state ${FIXTURE.stateFips}, got ${result.state_fips}`,
      );
      // The editor slices the last 3 chars to get county FIPS — verify the
      // field is still ≥ 3 chars long.
      assert(
        result.county_fips.length >= 3,
        `county_fips too short to slice(-3): "${result.county_fips}"`,
      );
      assert(
        result.county_fips.slice(-3) === FIXTURE.countyFips,
        `expected county ${FIXTURE.countyFips}, got ${result.county_fips.slice(-3)}`,
      );
    },
  },
  {
    name: 'Mapbox Map Matching — driving profile returns LineString',
    async fn() {
      assert(MAPBOX_TOKEN, 'MAPBOX_TOKEN env var is not set');
      // Two close points along Main St in Bozeman; map-matching should snap
      // them to the road graph.
      const coords = [
        [-111.0419, 45.6798],
        [-111.0400, 45.6798],
      ];
      const coordString = coords.map((c) => `${c[0]},${c[1]}`).join(';');
      const url =
        `https://api.mapbox.com/matching/v5/mapbox/driving/${coordString}` +
        `?access_token=${MAPBOX_TOKEN}&geometries=geojson&steps=false&overview=full`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await httpBody(res)}`);
      const data = await res.json();
      assert(data.code === 'Ok', `expected code "Ok", got "${data.code}"`);
      assert(
        Array.isArray(data.matchings) && data.matchings.length > 0,
        'no matchings array',
      );
      const geom = data.matchings[0].geometry;
      assert(geom?.type === 'LineString', `expected LineString geometry, got ${geom?.type}`);
      assert(
        Array.isArray(geom.coordinates) && geom.coordinates.length >= 2,
        `geometry has <2 coords: ${geom?.coordinates?.length}`,
      );
    },
  },
];

console.log('=== GTFS·X external-API contract checks ===\n');
for (const check of checks) {
  await run(check);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
console.log('='.repeat(60));

process.exit(failed.length > 0 ? 1 : 0);
