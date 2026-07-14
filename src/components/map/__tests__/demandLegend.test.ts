import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEMAND_SELECTION,
  DEMAND_FLAGS,
  FLAG_BITS,
  JOBS_CODE,
  POPULATION_CODES,
  compositeBits,
  roleForCode,
  type DemandSelection,
} from '../demandCategories';
import {
  DEMAND_DATA_READY,
  DEMAND_LEGEND,
  DEMAND_LEGEND_STATE,
  DEMAND_TILE_ARCHIVE,
  DEMAND_UNAVAILABLE_REASON,
  demandLegendRows,
  demandZoomWarning,
  formatPerDot,
  parseDemandLegend,
  perDotAtZoom,
  populationRoleCodes,
  strideAtZoom,
  tileZoomFor,
  type DemandLegend,
} from '../demandLegend';

// This suite makes drift between the pipeline's demand-legend.json and the
// frontend's tile schema a CI failure rather than a silently wrong map.
//
// Two distinct kinds of wrongness are defended against, and the second is the
// nasty one:
//
//   1. a wrong "1 dot ≈ N" — a number a planner would put in a memo;
//   2. WRONG FLAG BITS — which do not break anything visibly. Mapbox GL has no
//      bitwise operators, so every filter is an ENUMERATION of codes built from
//      the bit values. Ship a legend whose bits disagree with the frontend's and
//      the map keeps working perfectly while coloring the wrong people.
//
// Most assertions run against FIXTURES rather than the file on disk, so they pin
// the parser's behaviour whatever state the pipeline happens to be in. The tests
// at the bottom are the ones that look at the real file.

/** A legend shaped the way the pipeline emits it (attribute-dots-v1). */
function rawLegend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    archive: 'us-2026e',
    schema: 'attribute-dots-v1',
    source_layer: 'demand',
    attribute: 'd',
    min_zoom: 8,
    max_zoom: 15,
    jobs_code: 16,
    population_codes: [...POPULATION_CODES],
    flags: { carless: 1, low_income: 2, senior: 4, disability: 8 },
    // Strides: the z8 tiles carry every 16th dot; z12 and deeper carry all of them.
    // Deliberately NOT the live ladder, so the tests prove the values are read
    // rather than accidentally passing against a hardcoded 128.
    zoom_ladder: {
      strides: { 8: 16, 9: 8, 10: 4, 11: 2, 12: 1 },
      full_density_zoom: 12,
    },
    modes: {
      propensity: { segments: ['carless', 'low_income'] },
      need: { segments: ['carless', 'low_income', 'senior', 'disability'] },
    },
    // Two universes, two grains. Deliberately DIFFERENT here (5 vs 20) so the
    // tests prove the ratio is read per-universe rather than passing on a
    // uniform table.
    units: {
      population: {
        label: 'Residents', description: 'x', unit: 'people', per_dot: 5, source: 'acs',
      },
      jobs: {
        label: 'Jobs', description: 'x', unit: 'jobs', per_dot: 20, source: 'lodes',
      },
    },
    segments: {
      carless: { bit: 1, label: 'Carless', description: 'x', modes: ['propensity', 'need'], unit: 'people', source: 'acs' },
      low_income: { bit: 2, label: 'Low income', description: 'x', modes: ['propensity', 'need'], unit: 'people', source: 'acs' },
      senior: { bit: 4, label: 'Age 65+', description: 'x', modes: ['need'], unit: 'people', source: 'acs' },
      disability: { bit: 8, label: 'Disability', description: 'x', modes: ['need'], unit: 'people', source: 'acs' },
    },
    ...overrides,
  };
}

function fixture(overrides: Record<string, unknown> = {}): DemandLegend {
  const state = parseDemandLegend(rawLegend(overrides));
  if (state.status !== 'ok') throw new Error('fixture legend should parse');
  return state.legend;
}

const LEGEND = fixture();

/** The pre-attribute-dots legend: a `classes` map, no flags, no `d`. */
function oldSchemaLegend(): Record<string, unknown> {
  const cls = (perDot: number, minzoom = 8) => ({
    label: 'X', description: 'x', unit: 'people', per_dot: perDot, minzoom, source: 'acs',
  });
  return {
    archive: 'us-2026d',
    source_layer: 'demand',
    min_zoom: 8,
    max_zoom: 15,
    zoom_ladder: { strides: { 8: 128, 15: 1 }, full_density_zoom: 15 },
    modes: {
      propensity: { union: 'prop_all', backdrop: 'backdrop_prop', segments: ['carless', 'low_income'] },
      need: { union: 'need_all', backdrop: 'backdrop_need', segments: ['carless', 'low_income', 'senior', 'disability'] },
    },
    classes: {
      prop_all: cls(5), need_all: cls(5), backdrop_prop: cls(5), backdrop_need: cls(5),
      carless: cls(5, 9), low_income: cls(5, 9), senior: cls(5, 9), disability: cls(5, 9),
      jobs: cls(5),
    },
  };
}

describe('parseDemandLegend — schema drift fails LOUDLY', () => {
  it('parses a legend carrying the attribute-dot schema', () => {
    const state = parseDemandLegend(rawLegend());
    expect(state.status).toBe('ok');
    if (state.status !== 'ok') return;
    expect(state.legend.archive).toBe('us-2026e');
    expect(state.legend.attribute).toBe('d');
    expect(state.legend.population.perDot).toBe(5);
    expect(state.legend.jobs.perDot).toBe(20);
    for (const f of DEMAND_FLAGS) expect(state.legend.flags[f].bit).toBe(FLAG_BITS[f]);
  });

  // ── the bit values: the failure that would NOT look like a failure ──────────
  it('THROWS when a flag bit disagrees with the frontend (it would color the WRONG PEOPLE)', () => {
    expect(() =>
      parseDemandLegend(rawLegend({
        flags: { carless: 8, low_income: 2, senior: 4, disability: 1 },
      })),
    ).toThrow(/bit/i);
  });

  it('THROWS when the legend declares a flag the frontend does not know', () => {
    expect(() =>
      parseDemandLegend(rawLegend({
        flags: { carless: 1, low_income: 2, senior: 4, disability: 8, youth: 16 },
      })),
    ).toThrow(/youth/);
  });

  it('THROWS when the tile attribute is renamed', () => {
    expect(() => parseDemandLegend(rawLegend({ attribute: 'class' }))).toThrow(/attribute/i);
  });

  it('THROWS when the jobs code moves (jobs would be drawn as people)', () => {
    expect(() => parseDemandLegend(rawLegend({ jobs_code: 32 }))).toThrow(/jobs_code/);
  });

  // ── the composites: which people are "the rest of the group" ────────────────
  it('THROWS if the pipeline puts a need-only flag inside the propensity composite', () => {
    expect(() =>
      parseDemandLegend(rawLegend({
        modes: {
          propensity: { segments: ['carless', 'low_income', 'senior'] },
          need: { segments: ['carless', 'low_income', 'senior', 'disability'] },
        },
      })),
    ).toThrow(/propensity/);
  });

  it('THROWS if a mode\'s composite loses a flag the frontend still offers', () => {
    expect(() =>
      parseDemandLegend(rawLegend({
        modes: {
          propensity: { segments: ['carless'] },
          need: { segments: ['carless', 'low_income', 'senior', 'disability'] },
        },
      })),
    ).toThrow(/composite/);
  });

  // ── the ladder ─────────────────────────────────────────────────────────────
  it('THROWS when the zoom ladder is missing — the "1 dot ≈ N" would be a guess', () => {
    const raw = rawLegend();
    delete raw.zoom_ladder;
    expect(() => parseDemandLegend(raw)).toThrow(/zoom_ladder/);
  });

  it('THROWS when the strides are keep-FRACTIONS instead of denominators', () => {
    expect(() =>
      parseDemandLegend(rawLegend({
        zoom_ladder: { strides: { 8: 0.125, 12: 1 }, full_density_zoom: 12 },
      })),
    ).toThrow(/denominator/i);
  });

  it('THROWS when full_density_zoom disagrees with the strides it points at', () => {
    expect(() =>
      parseDemandLegend(rawLegend({
        zoom_ladder: { strides: { 8: 16, 12: 4 }, full_density_zoom: 12 },
      })),
    ).toThrow(/full density/i);
  });

  it('THROWS on a non-numeric per_dot', () => {
    const raw = rawLegend();
    (raw.units as Record<string, Record<string, unknown>>).population.per_dot = 'five';
    expect(() => parseDemandLegend(raw)).toThrow(/per_dot/);
  });

  // ── the old schema: stale, not broken ──────────────────────────────────────
  it('reports the PRE-ATTRIBUTE-DOTS legend as stale rather than throwing', () => {
    const state = parseDemandLegend(oldSchemaLegend());
    expect(state.status).toBe('stale');
    if (state.status !== 'stale') return;
    expect(state.reason).toMatch(/attribute-dot|rebuilt/i);
  });

  it('treats a legend with no `flags` block as stale, whatever else it has', () => {
    const raw = rawLegend();
    delete raw.flags;
    expect(parseDemandLegend(raw).status).toBe('stale');
  });
});

describe('zoom → effective dot density', () => {
  it('renders the tile zoom mapbox will actually ask for (floor, clamped)', () => {
    expect(tileZoomFor(7, LEGEND)).toBe(8);
    expect(tileZoomFor(10.9, LEGEND)).toBe(10);
    expect(tileZoomFor(18, LEGEND)).toBe(15);
  });

  it('reads the stride off the ladder', () => {
    expect(strideAtZoom(8, LEGEND)).toBe(16);
    expect(strideAtZoom(9, LEGEND)).toBe(8);
    expect(strideAtZoom(11, LEGEND)).toBe(2);
  });

  it('is full density at and beyond full_density_zoom, rungs or no rungs', () => {
    expect(strideAtZoom(12, LEGEND)).toBe(1);
    expect(strideAtZoom(15, LEGEND)).toBe(1);
    expect(strideAtZoom(20, LEGEND)).toBe(1);
  });

  it('carries a fractional zoom at the rung its TILE is on, not the next one', () => {
    expect(strideAtZoom(8.9, LEGEND)).toBe(16);
    expect(strideAtZoom(9.0, LEGEND)).toBe(8);
  });

  it('computes "1 dot ≈ N" as per_dot × the zoom sampling', () => {
    // population is 1:5, jobs 1:20 in this fixture.
    expect(perDotAtZoom('segment', 12, LEGEND)).toBe(5);
    expect(perDotAtZoom('segment', 8, LEGEND)).toBe(80);      // 5 × 16
    expect(perDotAtZoom('composite', 8, LEGEND)).toBe(80);    // same grain: a dot is a person
    expect(perDotAtZoom('backdrop', 8, LEGEND)).toBe(80);
    expect(perDotAtZoom('jobs', 8, LEGEND)).toBe(320);        // 20 × 16
  });

  it('gives every POPULATION role the same grain — a dot is a person', () => {
    // Mixed grain inside the population would make the map lie about relative
    // density: a 1:15 segment over a 1:5 backdrop draws a poor neighbourhood as
    // if two thirds of it were not poor.
    for (const z of [8, 10, 12, 15]) {
      const a = perDotAtZoom('segment', z, LEGEND);
      expect(perDotAtZoom('composite', z, LEGEND)).toBe(a);
      expect(perDotAtZoom('backdrop', z, LEGEND)).toBe(a);
    }
  });

  it('is monotonic: a dot is worth more people the further out you are', () => {
    let prev = 0;
    for (let z = 15; z >= 8; z--) {
      const v = perDotAtZoom('segment', z, LEGEND);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('formats big ratios readably', () => {
    expect(formatPerDot(1234)).toBe('1,234');
  });
});

describe('legend rows — what the panel actually shows', () => {
  it('shows one row per on-screen ROLE, in draw order', () => {
    const rows = demandLegendRows(DEFAULT_DEMAND_SELECTION, 12, LEGEND);
    expect(rows.map((r) => r.role)).toEqual(['segment', 'backdrop', 'jobs']);
  });

  it('adds the muted "rest of the composite" row when a segment is picked', () => {
    const sel: DemandSelection = {
      mode: 'propensity', segment: 'carless', jobs: true, backdrop: true,
    };
    const rows = demandLegendRows(sel, 12, LEGEND);
    expect(rows.map((r) => r.role)).toEqual(['segment', 'composite', 'backdrop', 'jobs']);
    expect(rows[0].label).toBe('Carless');
    expect(rows[1].label).toBe('Other likely riders');
    expect(rows[2].label).toBe('Everyone else');
    // The muted row must NOT be labelled as if it were the backdrop.
    expect(rows[1].label).not.toMatch(/everyone else/i);
  });

  it('drops the rows whose checkbox is off', () => {
    const sel: DemandSelection = {
      mode: 'need', segment: 'all', jobs: false, backdrop: false,
    };
    expect(demandLegendRows(sel, 12, LEGEND).map((r) => r.role)).toEqual(['segment']);
  });

  it('states the EFFECTIVE ratio for the current zoom, and updates as you zoom', () => {
    const at = (z: number) =>
      demandLegendRows(DEFAULT_DEMAND_SELECTION, z, LEGEND).find((r) => r.role === 'segment')!;
    expect(at(12).perDot).toBe(5);
    expect(at(8).perDot).toBe(80);
  });

  it('labels the composite radio as an estimate, and a named flag as a count', () => {
    const all = demandLegendRows(DEFAULT_DEMAND_SELECTION, 12, LEGEND);
    expect(all.find((r) => r.role === 'segment')!.isEstimate).toBe(true);

    const carless = demandLegendRows(
      { mode: 'propensity', segment: 'carless', jobs: true, backdrop: true }, 12, LEGEND,
    );
    expect(carless.find((r) => r.role === 'segment')!.isEstimate).toBe(false);
  });

  it('labels the segment row with the words on the control, not the pipeline\'s', () => {
    // The pipeline calls it "Age 65+"; the radio the user clicked says "Seniors 65+".
    const rows = demandLegendRows(
      { mode: 'need', segment: 'senior', jobs: false, backdrop: false }, 12, LEGEND,
    );
    expect(rows[0].label).toBe('Seniors 65+');
    expect(rows[1].label).toBe('Others with transit need');
  });

  it('uses the right unit per row', () => {
    const rows = demandLegendRows(DEFAULT_DEMAND_SELECTION, 12, LEGEND);
    expect(rows.find((r) => r.role === 'jobs')!.unit).toBe('jobs');
    expect(rows.find((r) => r.role === 'segment')!.unit).toBe('people');
  });

  // ── below the source minzoom: nothing is mounted, so no row may claim a ratio ──
  //
  // The layer's vector source carries `minzoom: legend.minZoom` — below that, zero
  // tiles are requested and zero dots are drawn, whatever the selection. A row's
  // `1 dot ≈ N` is only honest when its dot is actually on screen, so every row
  // must come back `hiddenAtZoom` here — the caller (MapLayerControls) uses this
  // flag to withhold the ratio text rather than state one for dots that don't
  // exist on screen. This regressed once: `hiddenAtZoom` was computed correctly
  // but only used to fade the row's opacity, never to hide the ratio.
  it('marks every row hiddenAtZoom below the source minzoom', () => {
    const rows = demandLegendRows(DEFAULT_DEMAND_SELECTION, 6, LEGEND);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.hiddenAtZoom).toBe(true);
  });

  it('still marks rows hiddenAtZoom on a fractional zoom below the gate', () => {
    const rows = demandLegendRows(DEFAULT_DEMAND_SELECTION, 7.9, LEGEND);
    for (const row of rows) expect(row.hiddenAtZoom).toBe(true);
  });

  it('clears hiddenAtZoom at and above the source minzoom, for every selection', () => {
    const rows = demandLegendRows(DEFAULT_DEMAND_SELECTION, 8, LEGEND);
    for (const row of rows) expect(row.hiddenAtZoom).toBe(false);

    const carless = demandLegendRows(
      { mode: 'propensity', segment: 'carless', jobs: true, backdrop: true }, 8, LEGEND,
    );
    for (const row of carless) expect(row.hiddenAtZoom).toBe(false);
  });
});

describe('THE RECONCILIATION: the panel\'s rows account for everybody', () => {
  it('covers every population code across the three population rows', () => {
    for (const mode of ['propensity', 'need'] as const) {
      for (const segment of ['all', 'carless', 'low_income'] as const) {
        const sel = { mode, segment, jobs: true, backdrop: true } as DemandSelection;
        const roles = populationRoleCodes(sel);
        const covered = [...roles.segment, ...roles.composite, ...roles.backdrop]
          .sort((a, b) => a - b);
        expect(covered).toEqual([...POPULATION_CODES]);
        // and jobs never leak into a population row
        expect(roles.jobs).toEqual([JOBS_CODE]);
      }
    }
  });

  it('never leaves a population code roleless while the backdrop is on', () => {
    const sel: DemandSelection = {
      mode: 'need', segment: 'disability', jobs: false, backdrop: true,
    };
    for (const code of POPULATION_CODES) expect(roleForCode(sel, code)).not.toBeNull();
    // The composite row is the people the OLD schema drew nowhere: anyone with a
    // need flag who is not disabled.
    const composite = populationRoleCodes(sel).composite;
    expect(composite).toContain(1);   // carless, not disabled
    expect(composite).toContain(2);   // low-income, not disabled
    expect(composite).toContain(4);   // senior, not disabled
    expect(composite).not.toContain(8);
    for (const code of composite) {
      expect(code & compositeBits('need')).not.toBe(0);
      expect(code & FLAG_BITS.disability).toBe(0);
    }
  });
});

describe('zoom warning', () => {
  it('warns below the source minzoom, where nothing draws at all', () => {
    expect(demandZoomWarning(DEFAULT_DEMAND_SELECTION, 6, LEGEND)).toMatch(/zoom in to level 8/i);
  });

  it('goes quiet at and above the source minzoom — every flag rides on a person', () => {
    // The old schema held the segment CLASSES back to z9, so picking "Carless"
    // at z8 drew literally nothing. A flag is not an extra dot, so there is no
    // per-segment gate left to warn about.
    expect(demandZoomWarning(DEFAULT_DEMAND_SELECTION, 8, LEGEND)).toBeNull();
    for (const segment of ['all', 'carless', 'low_income'] as const) {
      const sel = { mode: 'propensity', segment, jobs: true, backdrop: true } as DemandSelection;
      expect(demandZoomWarning(sel, 8, LEGEND)).toBeNull();
    }
    for (const segment of ['senior', 'disability'] as const) {
      const sel = { mode: 'need', segment, jobs: true, backdrop: true } as DemandSelection;
      expect(demandZoomWarning(sel, 8, LEGEND)).toBeNull();
    }
  });

  it('fires on fractional zooms below the gate', () => {
    expect(demandZoomWarning(DEFAULT_DEMAND_SELECTION, 7.9, LEGEND)).not.toBeNull();
  });
});

describe('the legend on disk', () => {
  it('either drives a drawable layer, or says why it cannot — never silently blank', () => {
    if (DEMAND_DATA_READY) {
      expect(DEMAND_LEGEND).not.toBeNull();
      expect(DEMAND_TILE_ARCHIVE).toBeTruthy();
      expect(DEMAND_UNAVAILABLE_REASON).toBeNull();
    } else {
      expect(DEMAND_UNAVAILABLE_REASON).toBeTruthy();
    }
  });

  it('agrees with the frontend\'s tile schema (checked at import, pinned here)', () => {
    if (DEMAND_LEGEND_STATE.status !== 'ok') return;
    const l = DEMAND_LEGEND_STATE.legend;
    expect(l.attribute).toBe('d');
    for (const f of DEMAND_FLAGS) expect(l.flags[f].bit).toBe(FLAG_BITS[f]);
  });

  it('declares a maxzoom the tiles actually have, so z16+ overzooms instead of blanking', () => {
    if (!DEMAND_LEGEND) return;
    // The layer went blank from z16 in once, because the legend said 16 and
    // tippecanoe built 15: Mapbox asked for a z16 tile that had never existed.
    expect(DEMAND_LEGEND.maxZoom).toBe(15);
    expect(DEMAND_LEGEND.minZoom).toBe(8);
    expect(strideAtZoom(16, DEMAND_LEGEND)).toBe(1);
    expect(strideAtZoom(18, DEMAND_LEGEND)).toBe(1);
  });

  it('gives every zoom in the source range a usable ratio, once it is live', () => {
    if (!DEMAND_LEGEND) return;
    for (let z = DEMAND_LEGEND.minZoom; z <= DEMAND_LEGEND.maxZoom; z++) {
      for (const row of demandLegendRows(DEFAULT_DEMAND_SELECTION, z, DEMAND_LEGEND)) {
        expect(Number.isFinite(row.perDot)).toBe(true);
        expect(row.perDot).toBeGreaterThan(0);
      }
    }
  });

  it('names the archive the pipeline built (the tile URL is derived from it)', () => {
    if (!DEMAND_LEGEND) return;
    expect(DEMAND_LEGEND.archive).toBe('us-2026f');
  });
});
