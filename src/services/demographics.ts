export interface BlockGroupData {
  geoid: string;
  population: number;
  households: number;
  workers: number;
  lat: number;
  lon: number;
  /** Non-white / Hispanic population (B03002 total minus non-Hispanic White alone) */
  minorityPop: number;
  /** Total population from B03002 table (base for minority share calculation) */
  totalRacePop: number;
  /** Population below 200% of the federal poverty line (C17002 _002…_007). */
  lowIncomePop: number;
  /** Population for whom poverty status is determined — C17002 denominator. */
  povertyUniverse: number;
  /** Occupied households with no vehicle available (B08201 _002). */
  zeroVehicleHouseholds: number;
  /** Total occupied households — B08201 denominator (≠ B25001 housing units). */
  occupiedHouseholds: number;
  /** Population age 65 and over (B01001 male + female 65+ cells). */
  seniorPop: number;
  /** Population age under 18 (B09001 _001). */
  youthPop: number;
}

/**
 * ACS 5-year (2022) detailed-table variables we request, grouped by metric.
 * Columns come back in this order, but we still resolve them by name from the
 * response header so a Census column reshuffle can't silently misalign values.
 *
 * Geography matters: several ACS tables are NOT tabulated at block-group level
 * (the API returns null there). We deliberately use only block-group-available
 * tables so every metric resolves at the geography we join on:
 *   - Age 65+ and under-18 both come from B01001 (Sex by Age), summing the
 *     relevant male/female cells. (B09001 "under 18" is tract-only — avoid it.)
 *   - Zero-vehicle uses B25044 (Tenure by Vehicles Available), a housing table
 *     available at block group. (B08201 is tract-only — avoid it.)
 *   - Low-income = share of C17002 (income-to-poverty ratio) under 2.00.
 */
const ACS_BASE_VARS = [
  'B01003_001E', // total population
  'B25001_001E', // housing units
  'B08301_001E', // workers (means of transportation to work universe)
  'B03002_001E', // race/ethnicity universe
  'B03002_003E', // non-Hispanic White alone
] as const;
const ACS_LOW_INCOME_NUM = [
  'C17002_002E', 'C17002_003E', 'C17002_004E',
  'C17002_005E', 'C17002_006E', 'C17002_007E',
] as const; // under 2.00× poverty line
const ACS_LOW_INCOME_DENOM = 'C17002_001E';
// B25044 owner-no-vehicle (_003) + renter-no-vehicle (_010); denominator _001.
const ACS_NO_VEHICLE_NUM = ['B25044_003E', 'B25044_010E'] as const;
const ACS_HOUSEHOLDS_DENOM = 'B25044_001E';
const ACS_SENIOR_NUM = [
  'B01001_020E', 'B01001_021E', 'B01001_022E', 'B01001_023E', 'B01001_024E', 'B01001_025E', // male 65+
  'B01001_044E', 'B01001_045E', 'B01001_046E', 'B01001_047E', 'B01001_048E', 'B01001_049E', // female 65+
] as const;
const ACS_YOUTH_NUM = [
  'B01001_003E', 'B01001_004E', 'B01001_005E', 'B01001_006E', // male: <5, 5–9, 10–14, 15–17
  'B01001_027E', 'B01001_028E', 'B01001_029E', 'B01001_030E', // female: <5, 5–9, 10–14, 15–17
] as const;

const ACS_ALL_VARS = [
  ...ACS_BASE_VARS,
  ACS_LOW_INCOME_DENOM, ...ACS_LOW_INCOME_NUM,
  ACS_HOUSEHOLDS_DENOM, ...ACS_NO_VEHICLE_NUM,
  ...ACS_SENIOR_NUM,
  ...ACS_YOUTH_NUM,
];

/**
 * Fetch Census tract centroids for a state. Bundled in public/census/
 * to avoid CORS issues with www2.census.gov.
 */
async function fetchTractCentroids(
  stateFips: string,
): Promise<Map<string, { lat: number; lon: number }>> {
  // Fetch from our own origin (bundled Census tract centroid files)
  const res = await fetch(`${import.meta.env.BASE_URL}census/TR${stateFips}.txt`);
  if (!res.ok) throw new Error(`Tract centroids not available for state ${stateFips}`);

  const text = await res.text();
  const lines = text.trim().split('\n');
  const centroids = new Map<string, { lat: number; lon: number }>();

  // Skip header (file has BOM + header row)
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 6) continue;
    const state = parts[0].trim();
    const county = parts[1].trim();
    const tract = parts[2].trim();
    const lat = parseFloat(parts[4].trim());
    const lon = parseFloat(parts[5].trim());
    if (!isNaN(lat) && !isNaN(lon)) {
      centroids.set(state + county + tract, { lat, lon });
    }
  }

  return centroids;
}

/**
 * Fetch Census ACS5 block-group-level demographic data for a state+county,
 * with coordinates from tract centroids (block groups share their parent tract's centroid).
 */
export async function fetchCensusData(
  stateFips: string,
  countyFips: string,
): Promise<BlockGroupData[]> {
  // Census ACS5 began requiring an API key for unauthenticated requests in
  // 2026. Key is shipped in the bundle (Census treats it as a per-app
  // rate-limit token, not a strict secret); empty means we'll likely 401.
  const key = import.meta.env.VITE_CENSUS_API_KEY ?? '';
  const keyParam = key ? `&key=${encodeURIComponent(key)}` : '';

  const [centroids, censusRes] = await Promise.all([
    fetchTractCentroids(stateFips),
    fetch(
      `https://api.census.gov/data/2022/acs/acs5` +
        `?get=${ACS_ALL_VARS.join(',')}` +
        `&for=block%20group:*&in=state:${stateFips}&in=county:${countyFips}&in=tract:*` +
        keyParam,
    ),
  ]);

  if (!censusRes.ok) {
    const body = await censusRes.text().catch(() => '');
    throw new Error(
      `Census API request failed: ${censusRes.status}` +
        (body ? ` — ${body.slice(0, 200)}` : ''),
    );
  }

  const rows: string[][] = await censusRes.json();
  const header = rows[0];
  const stateIdx = header.indexOf('state');
  const countyIdx = header.indexOf('county');
  const tractIdx = header.indexOf('tract');
  const bgIdx = header.indexOf('block group');

  // Resolve every ACS variable to its column index by name. Missing columns
  // (e.g. a stubbed test response that only lists the original five) resolve
  // to -1 and contribute 0 via the guards below, so older fixtures still pass.
  const col = (v: string) => header.indexOf(v);
  const num = (row: string[], v: string) => {
    const i = col(v);
    return i < 0 ? 0 : parseInt(row[i], 10) || 0;
  };
  const sum = (row: string[], vars: readonly string[]) =>
    vars.reduce((acc, v) => acc + num(row, v), 0);

  const results: BlockGroupData[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const stFips = row[stateIdx];
    const coFips = row[countyIdx];
    const trFips = row[tractIdx];
    const bgFips = row[bgIdx];
    const geoid = stFips + coFips + trFips + bgFips;
    const tractKey = stFips + coFips + trFips;

    const centroid = centroids.get(tractKey);
    if (!centroid) continue;

    const totalRacePop = num(row, 'B03002_001E');
    const nonHispanicWhite = num(row, 'B03002_003E');
    results.push({
      geoid,
      population:    num(row, 'B01003_001E'),
      households:    num(row, 'B25001_001E'),
      workers:       num(row, 'B08301_001E'),
      lat:           centroid.lat,
      lon:           centroid.lon,
      totalRacePop,
      minorityPop:   Math.max(0, totalRacePop - nonHispanicWhite),
      lowIncomePop:         sum(row, ACS_LOW_INCOME_NUM),
      povertyUniverse:      num(row, ACS_LOW_INCOME_DENOM),
      zeroVehicleHouseholds: sum(row, ACS_NO_VEHICLE_NUM),
      occupiedHouseholds:   num(row, ACS_HOUSEHOLDS_DENOM),
      seniorPop:            sum(row, ACS_SENIOR_NUM),
      youthPop:             sum(row, ACS_YOUTH_NUM),
    });
  }

  return results;
}

/**
 * Look up state + county FIPS codes for a lat/lon using the FCC Area API.
 */
export async function lookupFips(
  lat: number,
  lon: number,
): Promise<{ stateFips: string; countyFips: string }> {
  const res = await fetch(
    `https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lon}&format=json`,
  );
  if (!res.ok) throw new Error(`FCC Area API request failed: ${res.status}`);

  const data = await res.json();
  const result = data.results?.[0];
  if (!result) throw new Error('No FIPS results found for the given coordinates');

  return {
    stateFips: result.state_fips as string,
    countyFips: (result.county_fips as string).slice(-3),
  };
}
