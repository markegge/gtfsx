# Census tract centroid files (`TR<STATEFP>.txt`)

Bundled here so the browser can read them from our own origin — `www2.census.gov`
sends no CORS headers, so the app cannot fetch them directly.

## What the app does with them

`fetchTractCentroids()` in `src/services/demographics.ts` loads `TR<state>.txt`
and builds a `state+county+tract -> {lat, lon}` map. ACS block groups fetched from
the Census API are then joined to their **parent tract's** centroid (block groups
have no published centroid of their own), and any block group whose tract key is
missing from this file is **silently dropped**. So a GEOID mismatch here does not
error — it just makes a state's demographics quietly disappear. Keep these files
on the same geography vintage as the ACS release in `src/generated/acsVintage.ts`.

## Format

Six comma-separated columns, UTF-8 with a BOM, one header row, LF endings:

```
STATEFP,COUNTYFP,TRACTCE,POPULATION,LATITUDE,LONGITUDE
30,001,000100,1239,+45.174304,-112.987072
```

The parser is **positional** (`parts[0]`, `[1]`, `[2]`, `[4]`, `[5]`) and requires
at least 6 fields. `POPULATION` is carried for provenance but is not read by the
app. Latitude/longitude are signed, 6 decimal places, zero-padded.

## Source and vintage

| Files | Source | Vintage |
|---|---|---|
| All except `TR09.txt` | Census **2020 Centers of Population**, tract level (`www2.census.gov/geo/docs/reference/cenpop2020/tract/`) | 2020 decennial, population-weighted |
| `TR09.txt` (Connecticut) | Regenerated — see below | 2020 decennial blocks re-aggregated to 2025 planning-region tracts, population-weighted |

Coordinates are **population-weighted centroids** (centers of population), not
geometric centroids. That matters: the walkshed-overlap math treats the centroid
as where the block group's residents actually are, so a geometric centroid would
misplace people in tracts with a large empty half.

## The Connecticut exception

Connecticut replaced its 8 counties with 9 **planning regions** as
county-equivalents, effective with the ACS 2022 5-year release. Current ACS
returns CT block groups under planning-region county codes **110-190**; the 2020
Centers of Population file is frozen on the **old** county codes (001-015). Left
alone, every one of Connecticut's 2,717 block groups failed the centroid join and
CT showed no demographics at all.

`TR09.txt` is therefore regenerated on current geography, and rebuilt rather than
merely re-coded, because the old and new tract sets are not 1:1 (883 old tracts vs
884 current). The rebuild preserves population weighting:

1. Take 2020 census blocks (TIGER 2025 `TABBLOCK20`, CT) with `POP20` and each
   block's official internal point.
2. Assign each block's internal point to a current-geography tract polygon
   (TIGER 2025 `TRACT` for CT, which *is* on planning regions).
3. Compute the population-weighted centroid per tract using the Census
   center-of-population formula (longitude weighted by `cos(lat)`).

Validated by running the same method against the **old** geography and diffing it
against the shipped Centers of Population values: median error 0.1 m, p95 0.8 m,
population an exact match on all 876 comparable tracts. The 8 current tracts with
zero population have no weighted center and fall back to the TIGER internal point.

Note that CT is only broken in *this* direction. The demand-dot and coverage
builds have the opposite problem — they join ACS block groups to TIGER *blocks*,
which still carry old CT county codes — and solve it by pinning CT to ACS 2021
(`ACS_YEAR_BY_STATE` in `demand-dots/build_dots.py` and
`demand-dots/coverage-pipeline/build_coverage_blocks.py`).

## Regenerating

Non-CT states: download the tract-level file for the state from the Census 2020
Centers of Population directory linked above; the columns already match.

Connecticut: re-run the block re-aggregation described above whenever TIGER's CT
tract geography changes. If TIGER ever re-codes `TABBLOCK20` onto planning
regions, drop the `ACS_YEAR_BY_STATE` CT pin in the two demand-dot builders at the
same time — the two workarounds exist for the same underlying split and should be
retired together.
