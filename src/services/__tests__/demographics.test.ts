/**
 * Unit tests for src/services/demographics.ts — mocked fetch.
 *
 * Catches code-side regressions like the 2026 Census API-key oversight:
 * the test "appends key when VITE_CENSUS_API_KEY is set" asserts that the
 * call URL actually contains `&key=…`. If someone strips that branch out
 * during a refactor, CI goes red. Real-API contract drift (Census changing
 * their auth policy) is handled by .github/workflows/external-apis.yml.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ACS vintage is generated, not hardcoded (demand-dots/acs_vintage.py probes
// the Census API and emits src/generated/acsVintage.ts). Assert against the same
// constant the app uses, so bumping the vintage never means editing this test.
import { ACS_YEAR } from '../../generated/acsVintage';

// Stub the bundled tract-centroid file fetch. Three deterministic centroids
// keyed by state+county+tract so every imported block group has coords.
const TRACT_FILE = `STATE,COUNTY,TRACT,FOO,INTPTLAT,INTPTLON
06,001,400100,_,37.8000,-122.2000
06,001,400200,_,37.8100,-122.2100
06,001,400300,_,37.8200,-122.2200
`;

// Minimal ACS5 response: header row + 2 block groups.
// Columns: B01003_001E, B25001_001E, B08301_001E, B03002_001E, B03002_003E, state, county, tract, block group
const ACS_RESPONSE = [
  ['B01003_001E', 'B25001_001E', 'B08301_001E', 'B03002_001E', 'B03002_003E', 'state', 'county', 'tract', 'block group'],
  ['1500', '600', '700', '1500', '900', '06', '001', '400100', '1'],
  ['2000', '800', '1100', '2000', '500', '06', '001', '400200', '2'],
];

function mockFetchOnce(responses: Array<{ ok?: boolean; status?: number; body: unknown; isText?: boolean }>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: () => Promise.resolve(r.isText ? (r.body as string) : JSON.stringify(r.body)),
      json: () => Promise.resolve(r.body),
    });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('demographics.fetchCensusData', () => {
  beforeEach(() => {
    vi.stubEnv('BASE_URL', '/');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('appends &key= when VITE_CENSUS_API_KEY is set', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'secret-key-123');
    const fetchMock = mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: ACS_RESPONSE },
    ]);

    const { fetchCensusData } = await import('../demographics');
    await fetchCensusData('06', '001');

    const censusUrl = fetchMock.mock.calls[1][0] as string;
    expect(censusUrl).toContain(`api.census.gov/data/${ACS_YEAR}/acs/acs5`);
    expect(censusUrl).toContain('&key=secret-key-123');
  });

  it('omits &key= when VITE_CENSUS_API_KEY is empty', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', '');
    const fetchMock = mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: ACS_RESPONSE },
    ]);

    const { fetchCensusData } = await import('../demographics');
    await fetchCensusData('06', '001');

    const censusUrl = fetchMock.mock.calls[1][0] as string;
    expect(censusUrl).not.toContain('&key=');
  });

  it('URL-encodes the API key', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'has spaces & symbols');
    const fetchMock = mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: ACS_RESPONSE },
    ]);

    const { fetchCensusData } = await import('../demographics');
    await fetchCensusData('06', '001');

    const censusUrl = fetchMock.mock.calls[1][0] as string;
    expect(censusUrl).toContain('&key=has%20spaces%20%26%20symbols');
  });

  it('joins block groups to parent-tract centroids', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: ACS_RESPONSE },
    ]);

    const { fetchCensusData } = await import('../demographics');
    const result = await fetchCensusData('06', '001');

    expect(result).toHaveLength(2);
    const bg1 = result.find((r) => r.geoid === '060014001001');
    expect(bg1).toBeDefined();
    expect(bg1?.lat).toBeCloseTo(37.8);
    expect(bg1?.lon).toBeCloseTo(-122.2);
    expect(bg1?.population).toBe(1500);
    expect(bg1?.households).toBe(600);
    expect(bg1?.workers).toBe(700);
  });

  it('computes minorityPop = totalRacePop - nonHispanicWhite', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: ACS_RESPONSE },
    ]);

    const { fetchCensusData } = await import('../demographics');
    const result = await fetchCensusData('06', '001');

    // First BG: total 1500, non-Hispanic White 900 → minority 600
    expect(result[0].minorityPop).toBe(600);
    // Second BG: total 2000, non-Hispanic White 500 → minority 1500
    expect(result[1].minorityPop).toBe(1500);
  });

  it('clamps minorityPop to 0 (never negative) when non-Hispanic White > total', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    const skewedAcs = [
      ['B01003_001E', 'B25001_001E', 'B08301_001E', 'B03002_001E', 'B03002_003E', 'state', 'county', 'tract', 'block group'],
      ['100', '40', '60', '100', '150', '06', '001', '400100', '1'],
    ];
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: skewedAcs },
    ]);

    const { fetchCensusData } = await import('../demographics');
    const result = await fetchCensusData('06', '001');
    expect(result[0].minorityPop).toBe(0);
  });

  it('computes highPropensityRiders with the demand-dot model', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    // renterPop  = round(250/500 × 1000)      = 500
    // zeroVehPop = (20 + 30) × 2.0            = 100
    // pop_18_24  = 8 cells × 10               = 80
    // high       = min(1000, round((500+100+80) × 0.6)) = min(1000, 408) = 408
    const hpAcs = [
      ['B01003_001E', 'B25003_001E', 'B25003_003E', 'B25044_003E', 'B25044_010E', 'B25010_001E',
        'B01001_007E', 'B01001_008E', 'B01001_009E', 'B01001_010E',
        'B01001_031E', 'B01001_032E', 'B01001_033E', 'B01001_034E',
        'state', 'county', 'tract', 'block group'],
      ['1000', '500', '250', '20', '30', '2.0',
        '10', '10', '10', '10', '10', '10', '10', '10',
        '06', '001', '400100', '1'],
    ];
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: hpAcs },
    ]);

    const { fetchCensusData } = await import('../demographics');
    const result = await fetchCensusData('06', '001');
    expect(result[0].highPropensityRiders).toBe(408);
  });

  it('caps highPropensityRiders at total population', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    // Everyone is a renter in a car-free household → scaled sum exceeds pop.
    const cappedAcs = [
      ['B01003_001E', 'B25003_001E', 'B25003_003E', 'B25044_003E', 'B25044_010E', 'B25010_001E',
        'state', 'county', 'tract', 'block group'],
      ['100', '100', '100', '90', '0', '3.0', '06', '001', '400100', '1'],
    ];
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: cappedAcs },
    ]);

    const { fetchCensusData } = await import('../demographics');
    const result = await fetchCensusData('06', '001');
    expect(result[0].highPropensityRiders).toBe(100);
  });

  it('throws with response body excerpt when Census API returns non-ok', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { ok: false, status: 403, body: 'A valid key was required for this dataset.', isText: true },
    ]);

    const { fetchCensusData } = await import('../demographics');
    await expect(fetchCensusData('06', '001')).rejects.toThrow(/Census API request failed: 403/);
  });

  it('throws when tract centroid file is unavailable', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    mockFetchOnce([
      { ok: false, status: 404, body: 'not found', isText: true },
      { body: ACS_RESPONSE },
    ]);

    const { fetchCensusData } = await import('../demographics');
    await expect(fetchCensusData('06', '001')).rejects.toThrow(/Tract centroids not available/);
  });

  it('drops block groups whose tract has no centroid (missing-coord guard)', async () => {
    vi.stubEnv('VITE_CENSUS_API_KEY', 'k');
    const orphanAcs = [
      ['B01003_001E', 'B25001_001E', 'B08301_001E', 'B03002_001E', 'B03002_003E', 'state', 'county', 'tract', 'block group'],
      ['1500', '600', '700', '1500', '900', '06', '001', '400100', '1'],
      ['9999', '99', '99', '99', '0', '06', '001', '999999', '1'], // no matching centroid
    ];
    mockFetchOnce([
      { body: TRACT_FILE, isText: true },
      { body: orphanAcs },
    ]);

    const { fetchCensusData } = await import('../demographics');
    const result = await fetchCensusData('06', '001');
    expect(result).toHaveLength(1);
    expect(result[0].geoid).toBe('060014001001');
  });
});

describe('demographics.lookupFips', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns last-3-digits county FIPS from FCC response', async () => {
    mockFetchOnce([
      { body: { results: [{ state_fips: '06', county_fips: '06001' }] } },
    ]);

    const { lookupFips } = await import('../demographics');
    const result = await lookupFips(37.8, -122.2);
    expect(result).toEqual({ stateFips: '06', countyFips: '001' });
  });

  it('throws on FCC HTTP error', async () => {
    mockFetchOnce([{ ok: false, status: 500, body: '' }]);
    const { lookupFips } = await import('../demographics');
    await expect(lookupFips(37.8, -122.2)).rejects.toThrow(/FCC Area API request failed: 500/);
  });

  it('throws when FCC returns no results for the coordinates', async () => {
    mockFetchOnce([{ body: { results: [] } }]);
    const { lookupFips } = await import('../demographics');
    await expect(lookupFips(0, 0)).rejects.toThrow(/No FIPS results/);
  });
});
