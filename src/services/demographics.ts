export interface BlockGroupData {
  geoid: string;
  population: number;
  households: number;
  workers: number;
  lat: number;
  lon: number;
}

/**
 * Fetch Census tract centroids for a state from the Census Bureau's
 * population centroid file. Returns a map from state+county+tract FIPS to { lat, lon }.
 */
async function fetchTractCentroids(
  stateFips: string,
): Promise<Map<string, { lat: number; lon: number }>> {
  const url = `https://www2.census.gov/geo/docs/reference/cenpop2020/tract/CenPop2020_Mean_TR${stateFips}.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch tract centroids: ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split('\n');
  const centroids = new Map<string, { lat: number; lon: number }>();

  // Skip header
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
  const [centroids, censusRes] = await Promise.all([
    fetchTractCentroids(stateFips),
    fetch(
      `https://api.census.gov/data/2022/acs/acs5?get=B01003_001E,B25001_001E,B08301_001E` +
        `&for=block%20group:*&in=state:${stateFips}&in=county:${countyFips}&in=tract:*`,
    ),
  ]);

  if (!censusRes.ok) throw new Error(`Census API request failed: ${censusRes.status}`);

  const rows: string[][] = await censusRes.json();
  const header = rows[0];
  const stateIdx = header.indexOf('state');
  const countyIdx = header.indexOf('county');
  const tractIdx = header.indexOf('tract');
  const bgIdx = header.indexOf('block group');

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

    results.push({
      geoid,
      population: parseInt(row[0], 10) || 0,
      households: parseInt(row[1], 10) || 0,
      workers: parseInt(row[2], 10) || 0,
      lat: centroid.lat,
      lon: centroid.lon,
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
    countyFips: result.county_fips as string,
  };
}
