import { describe, it, expect } from 'vitest';
import {
  BACKDROP_COLOR,
  COMPOSITE_COLOR,
  DEFAULT_DEMAND_SELECTION,
  DEMAND_ATTR,
  DEMAND_CIRCLE_OPACITY,
  DEMAND_CODES,
  DEMAND_FLAGS,
  DEMAND_MODES,
  DEMAND_SEGMENTS,
  FLAG_BITS,
  JOBS_CODE,
  JOBS_COLOR,
  POPULATION_CODES,
  ROLE_COLORS,
  SEGMENT_COLOR,
  activeDemandCodes,
  activeDemandRoles,
  buildDemandColor,
  buildDemandFilter,
  codeHasFlag,
  codesByRole,
  compositeBits,
  demandModeDef,
  flagsOfCode,
  isCompositeSelected,
  isPropensitySegment,
  isSegmentSelectable,
  roleForCode,
  segmentsForMode,
  setDemandBackdrop,
  setDemandJobs,
  setDemandMode,
  setDemandSegment,
  type DemandMode,
  type DemandRole,
  type DemandSegment,
  type DemandSelection,
} from '../demandCategories';

/** Pull the code list out of ['in', ['get','d'], ['literal', [...]]]. */
function filterCodes(filter: unknown): number[] {
  const f = filter as [string, unknown, [string, number[]]];
  return f[2][1];
}

/** Pull code→color out of ['match', ['get','d'], c, col, …, fallback]. */
function colorMap(expr: unknown): Map<number, string> {
  const e = expr as unknown[];
  const out = new Map<number, string>();
  for (let i = 2; i < e.length - 1; i += 2) out.set(e[i] as number, e[i + 1] as string);
  return out;
}

/** Every legal selection: 2 modes × their radios × jobs × backdrop. */
function everySelection(): DemandSelection[] {
  const out: DemandSelection[] = [];
  for (const jobs of [false, true]) {
    for (const backdrop of [false, true]) {
      for (const segment of ['all', 'carless', 'low_income'] as const) {
        out.push({ mode: 'propensity', segment, jobs, backdrop });
      }
      for (const segment of ['all', 'carless', 'low_income', 'senior', 'disability'] as const) {
        out.push({ mode: 'need', segment, jobs, backdrop });
      }
    }
  }
  return out;
}

describe('the tile schema — one dot is one person, flags packed into `d`', () => {
  it('packs the four flags into bits 1/2/4/8 of a single integer', () => {
    expect(DEMAND_ATTR).toBe('d');
    expect(FLAG_BITS).toEqual({ carless: 1, low_income: 2, senior: 4, disability: 8 });
    expect(DEMAND_FLAGS).toEqual(['carless', 'low_income', 'senior', 'disability']);
  });

  it('has sixteen population codes and one jobs code', () => {
    expect(POPULATION_CODES).toEqual([...Array(16).keys()]);
    expect(JOBS_CODE).toBe(16);
    expect(DEMAND_CODES).toHaveLength(17);
  });

  it('decodes a code back to the flags it carries', () => {
    expect(flagsOfCode(0)).toEqual([]);
    expect(flagsOfCode(1)).toEqual(['carless']);
    expect(flagsOfCode(3)).toEqual(['carless', 'low_income']);
    expect(flagsOfCode(12)).toEqual(['senior', 'disability']);
    expect(flagsOfCode(15)).toEqual(['carless', 'low_income', 'senior', 'disability']);
  });

  it('is a bijection: every code is exactly one combination of flags', () => {
    const seen = new Set<string>();
    for (const code of POPULATION_CODES) {
      const key = flagsOfCode(code).join('+');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      // and the flags round-trip back to the code
      const back = flagsOfCode(code).reduce((acc, f) => acc | FLAG_BITS[f], 0);
      expect(back).toBe(code);
    }
    expect(seen.size).toBe(16);
  });

  it('says a carless+low-income person is ONE dot with two flags, not two dots', () => {
    // The old schema emitted that person four times: once in `carless`, once in
    // `low_income`, once in `prop_all`, once in `need_all`.
    const code = FLAG_BITS.carless | FLAG_BITS.low_income;
    expect(code).toBe(3);
    expect(codeHasFlag(code, 'carless')).toBe(true);
    expect(codeHasFlag(code, 'low_income')).toBe(true);
    expect(codeHasFlag(code, 'senior')).toBe(false);
  });

  it('composites are unions of flags, computed — not tile classes', () => {
    expect(compositeBits('propensity')).toBe(FLAG_BITS.carless | FLAG_BITS.low_income);
    expect(compositeBits('need')).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BUG. This block is the reason the schema changed. Read it before touching
// roleForCode.
//
// The old tiles carried a `backdrop_prop` class = population − (carless ∪
// low_income). With the Carless segment selected the map drew `carless` + that
// backdrop — so a person who was low-income but NOT carless was in neither, and
// was drawn NOWHERE. Nothing double-counted, every old invariant passed, and ~24%
// of the population silently vanished from the map.
describe('THE PARTITION: every person is drawn exactly once, in every view', () => {
  it('gives EVERY population code a role when the backdrop is on — nobody vanishes', () => {
    for (const sel of everySelection().filter((s) => s.backdrop)) {
      for (const code of POPULATION_CODES) {
        const role = roleForCode(sel, code);
        expect(role, `code ${code} (${flagsOfCode(code).join('+') || 'none'}) is drawn ` +
          `NOWHERE under ${sel.mode}/${sel.segment} — this is the bug`).not.toBeNull();
      }
    }
  });

  it('gives every code EXACTLY ONE role — nobody is drawn twice', () => {
    for (const sel of everySelection()) {
      const byRole = codesByRole(sel);
      const all = [...byRole.segment, ...byRole.composite, ...byRole.backdrop, ...byRole.jobs];
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('partitions the population into segment ∪ composite ∪ backdrop, exactly', () => {
    for (const sel of everySelection().filter((s) => s.backdrop)) {
      const { segment, composite, backdrop } = codesByRole(sel);
      const union = [...segment, ...composite, ...backdrop].sort((a, b) => a - b);
      expect(union).toEqual([...POPULATION_CODES]);
    }
  });

  it('REGRESSION: with Carless selected, the low-income-not-carless people are DRAWN', () => {
    // The exact people the old schema lost. Code 2 = low_income only.
    const sel: DemandSelection = {
      mode: 'propensity', segment: 'carless', jobs: false, backdrop: true,
    };
    expect(roleForCode(sel, 2)).toBe('composite');       // drawn, muted — not gone
    expect(roleForCode(sel, 1)).toBe('segment');         // carless only
    expect(roleForCode(sel, 3)).toBe('segment');         // carless AND low-income
    expect(roleForCode(sel, 0)).toBe('backdrop');        // genuinely everyone else
    // and the muted role is NOT empty — the tone actually appears on screen.
    expect(codesByRole(sel).composite.length).toBeGreaterThan(0);
  });

  it('draws the composite role whenever a specific segment is picked, in both modes', () => {
    for (const sel of everySelection()) {
      const { composite } = codesByRole(sel);
      if (sel.segment === 'all') {
        // With ALL selected the composite IS the selection: nothing is "the rest".
        expect(composite).toEqual([]);
      } else {
        expect(composite.length).toBeGreaterThan(0);
      }
    }
  });

  it('makes the backdrop mean population − SELECTION, never population − composite', () => {
    // The whole fix, stated as arithmetic: a backdrop dot is a dot with no
    // composite flag at all. It does not depend on which segment is selected.
    for (const sel of everySelection().filter((s) => s.backdrop)) {
      const bits = compositeBits(sel.mode);
      for (const code of codesByRole(sel).backdrop) {
        expect(code & bits).toBe(0);
      }
      // ...and every code with no composite flag IS in the backdrop.
      const expected = POPULATION_CODES.filter((c) => (c & bits) === 0);
      expect(codesByRole(sel).backdrop.sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it('never lets the selected segment escape its mode\'s composite', () => {
    // This is what keeps segment/composite/backdrop a partition. If a selectable
    // segment were NOT inside the composite, its dots would be simultaneously
    // "the segment" and "not in the composite" — an impossible role.
    for (const sel of everySelection()) {
      const bits = compositeBits(sel.mode);
      for (const code of codesByRole(sel).segment) {
        expect(code & bits).not.toBe(0);
      }
    }
  });

  it('keeps a car-owning senior OUT of propensity (the compile-time invariant)', () => {
    // Code 4 = senior only: no car problem, not poor. In NEED mode they are in the
    // composite. In PROPENSITY mode they must be plain backdrop — never blue,
    // never muted. `senior` is not even selectable in propensity, by TYPE.
    const prop: DemandSelection = {
      mode: 'propensity', segment: 'all', jobs: false, backdrop: true,
    };
    const need: DemandSelection = {
      mode: 'need', segment: 'all', jobs: false, backdrop: true,
    };
    expect(roleForCode(prop, 4)).toBe('backdrop');
    expect(roleForCode(need, 4)).toBe('segment');
    // A senior who is ALSO carless (code 5) is a likely rider — on the carless
    // ticket, not the senior one.
    expect(roleForCode(prop, 5)).toBe('segment');
    expect(isSegmentSelectable('propensity', 'senior')).toBe(false);
    expect(isSegmentSelectable('propensity', 'disability')).toBe(false);
  });

  it('never lets jobs collide with a population code (different universe)', () => {
    for (const sel of everySelection()) {
      const { jobs, segment, composite, backdrop } = codesByRole(sel);
      for (const j of jobs) expect(POPULATION_CODES).not.toContain(j);
      expect(jobs).toEqual(sel.jobs ? [JOBS_CODE] : []);
      for (const c of [...segment, ...composite, ...backdrop]) expect(c).toBeLessThan(16);
    }
  });

  it('drops ONLY what the user unchecked', () => {
    for (const sel of everySelection()) {
      const codes = activeDemandCodes(sel);
      expect(codes.includes(JOBS_CODE)).toBe(sel.jobs);
      // Backdrop off hides the no-flag people and nothing else.
      const bits = compositeBits(sel.mode);
      for (const code of POPULATION_CODES) {
        const inComposite = (code & bits) !== 0;
        expect(codes.includes(code)).toBe(inComposite || sel.backdrop);
      }
    }
  });
});

describe('selectability (illegal states are unrepresentable)', () => {
  it('offers ALL + carless + low income in propensity — and nothing else', () => {
    expect(segmentsForMode('propensity').map((s) => s.id)).toEqual(['carless', 'low_income']);
  });

  it('offers all four segments in need mode', () => {
    expect(segmentsForMode('need').map((s) => s.id)).toEqual([
      'carless', 'low_income', 'senior', 'disability',
    ]);
  });

  it('matches each mode\'s offered segments to its composite exactly', () => {
    for (const m of DEMAND_MODES) {
      expect(segmentsForMode(m.id).map((s) => s.id).sort()).toEqual([...m.composite].sort());
    }
  });

  it('refuses senior/disability in propensity at runtime as well as at compile time', () => {
    expect(isPropensitySegment('senior')).toBe(false);
    expect(isPropensitySegment('disability')).toBe(false);
    expect(isPropensitySegment('carless')).toBe(true);
    expect(isPropensitySegment('all')).toBe(true);
  });

  it('makes the illegal pairing a TYPE error', () => {
    // @ts-expect-error — 'senior' is not a PropensitySegment. If this line ever
    // stops erroring, the compile-time guarantee is gone and a car-owning senior
    // can be painted as a likely rider.
    const bad: DemandSelection = { mode: 'propensity', segment: 'senior', jobs: true, backdrop: true };
    expect(bad).toBeTruthy();
  });

  it('has no way to represent two segments at once', () => {
    const sel = DEFAULT_DEMAND_SELECTION;
    // `segment` is a single value, not a set — there is no two-segment state to
    // render, and therefore no need to define what "the rest of the composite"
    // would even mean against two selections.
    expect(Array.isArray(sel.segment)).toBe(false);
  });

  it('agrees between the per-segment `modes` table and the runtime gate', () => {
    for (const seg of DEMAND_SEGMENTS) {
      for (const mode of ['propensity', 'need'] as DemandMode[]) {
        expect(isSegmentSelectable(mode, seg.id)).toBe(seg.modes.includes(mode));
      }
    }
  });

  it('knows when the composite (an estimate) is what\'s on screen', () => {
    expect(isCompositeSelected(DEFAULT_DEMAND_SELECTION)).toBe(true);
    expect(isCompositeSelected({ ...DEFAULT_DEMAND_SELECTION, segment: 'carless' })).toBe(false);
  });
});

describe('transitions', () => {
  const base = DEFAULT_DEMAND_SELECTION;

  it('defaults to propensity + the composite + both companions', () => {
    expect(base).toEqual({ mode: 'propensity', segment: 'all', jobs: true, backdrop: true });
  });

  it('drops a need-only segment back to ALL when switching to propensity', () => {
    const need: DemandSelection = { mode: 'need', segment: 'senior', jobs: true, backdrop: true };
    expect(setDemandMode(need, 'propensity')).toEqual({
      mode: 'propensity', segment: 'all', jobs: true, backdrop: true,
    });
  });

  it('carries a shared segment across the mode switch (same person set)', () => {
    const prop: DemandSelection = {
      mode: 'propensity', segment: 'carless', jobs: false, backdrop: true,
    };
    const need = setDemandMode(prop, 'need');
    expect(need.segment).toBe('carless');
    expect(setDemandMode(need, 'propensity').segment).toBe('carless');
  });

  it('keeps the companions across a mode switch', () => {
    const sel: DemandSelection = {
      mode: 'propensity', segment: 'all', jobs: false, backdrop: false,
    };
    const next = setDemandMode(sel, 'need');
    expect(next.jobs).toBe(false);
    expect(next.backdrop).toBe(false);
  });

  it('never produces an illegal selection through ANY sequence of moves', () => {
    const moves: ((s: DemandSelection) => DemandSelection)[] = [
      (s) => setDemandMode(s, 'propensity'),
      (s) => setDemandMode(s, 'need'),
      (s) => setDemandSegment(s, 'all'),
      (s) => setDemandSegment(s, 'carless'),
      (s) => setDemandSegment(s, 'low_income'),
      (s) => setDemandSegment(s, 'senior' as DemandSegment),
      (s) => setDemandSegment(s, 'disability' as DemandSegment),
      (s) => setDemandJobs(s, !s.jobs),
      (s) => setDemandBackdrop(s, !s.backdrop),
    ];
    let sel = DEFAULT_DEMAND_SELECTION;
    // Deterministic walk over every move, repeatedly — after each one the
    // selection must still be legal AND the partition must still hold.
    for (let round = 0; round < 6; round++) {
      for (const move of moves) {
        sel = move(sel);
        expect(isSegmentSelectable(sel.mode, sel.segment)).toBe(true);
        if (sel.backdrop) {
          for (const code of POPULATION_CODES) expect(roleForCode(sel, code)).not.toBeNull();
        }
      }
    }
  });

  it('refuses (rather than silently coerces) a need-only segment in propensity', () => {
    const sel: DemandSelection = {
      mode: 'propensity', segment: 'carless', jobs: true, backdrop: true,
    };
    expect(setDemandSegment(sel, 'senior' as DemandSegment)).toBe(sel);
  });

  it('toggles the two companions independently of mode and segment', () => {
    let sel = setDemandJobs(DEFAULT_DEMAND_SELECTION, false);
    expect(sel.jobs).toBe(false);
    expect(sel.segment).toBe('all');
    sel = setDemandBackdrop(sel, false);
    expect(sel.backdrop).toBe(false);
    expect(sel.mode).toBe('propensity');
  });

  it('is a no-op when switching to the mode already selected', () => {
    expect(setDemandMode(DEFAULT_DEMAND_SELECTION, 'propensity')).toBe(DEFAULT_DEMAND_SELECTION);
  });
});

describe('mapbox expressions (enumerated — GL has no bitwise operators)', () => {
  it('filters on the integer `d` attribute', () => {
    const f = buildDemandFilter(DEFAULT_DEMAND_SELECTION) as unknown[];
    expect(f[0]).toBe('in');
    expect(f[1]).toEqual(['get', 'd']);
  });

  it('carries every code when both companions are on', () => {
    const codes = filterCodes(buildDemandFilter(DEFAULT_DEMAND_SELECTION));
    expect(codes.sort((a, b) => a - b)).toEqual([...DEMAND_CODES]);
  });

  it('enumerates exactly the codes a bitwise test would have selected', () => {
    // The filter is an enumeration precisely BECAUSE Mapbox GL cannot do
    // ['&', ['get','d'], 1]. Prove the enumeration is the same set.
    const sel: DemandSelection = {
      mode: 'need', segment: 'disability', jobs: false, backdrop: false,
    };
    const drawn = filterCodes(buildDemandFilter(sel));
    // backdrop off, jobs off → only composite members remain (any need flag).
    expect(drawn.sort((a, b) => a - b)).toEqual(
      POPULATION_CODES.filter((c) => c !== 0),
    );
    const byRole = codesByRole(sel);
    expect(byRole.segment.sort((a, b) => a - b)).toEqual(
      POPULATION_CODES.filter((c) => codeHasFlag(c, 'disability')),
    );
  });

  it('paints color per ROLE, and the SAME dot changes color with the selection', () => {
    // This is the heart of attribute dots: code 2 (low-income, not carless) is
    // the strong blue when you select Low income, and the muted tone when you
    // select Carless. One dot, two views, no retiling.
    const onLowIncome = colorMap(buildDemandColor({
      mode: 'propensity', segment: 'low_income', jobs: true, backdrop: true,
    }));
    const onCarless = colorMap(buildDemandColor({
      mode: 'propensity', segment: 'carless', jobs: true, backdrop: true,
    }));
    expect(onLowIncome.get(2)).toBe(SEGMENT_COLOR);
    expect(onCarless.get(2)).toBe(COMPOSITE_COLOR);
    // ...while a dot with neither flag is gray in both, and jobs stay orange.
    expect(onLowIncome.get(0)).toBe(BACKDROP_COLOR);
    expect(onCarless.get(0)).toBe(BACKDROP_COLOR);
    expect(onCarless.get(JOBS_CODE)).toBe(JOBS_COLOR);
  });

  it('colors every drawn code, and only drawn codes', () => {
    for (const sel of everySelection()) {
      const map = colorMap(buildDemandColor(sel));
      const drawn = activeDemandCodes(sel);
      expect([...map.keys()].sort((a, b) => a - b)).toEqual([...drawn].sort((a, b) => a - b));
      for (const code of drawn) {
        const role = roleForCode(sel, code) as DemandRole;
        expect(map.get(code)).toBe(ROLE_COLORS[role]);
      }
    }
  });

  it('lists the on-screen roles in draw order', () => {
    expect(activeDemandRoles(DEFAULT_DEMAND_SELECTION)).toEqual(['segment', 'backdrop', 'jobs']);
    expect(activeDemandRoles({
      mode: 'need', segment: 'senior', jobs: true, backdrop: true,
    })).toEqual(['segment', 'composite', 'backdrop', 'jobs']);
    expect(activeDemandRoles({
      mode: 'need', segment: 'senior', jobs: false, backdrop: false,
    })).toEqual(['segment', 'composite']);
  });

  it('paints opacity from a plain zoom ramp, and never fades the dots away', () => {
    const ramp = DEMAND_CIRCLE_OPACITY as unknown as (string | number | unknown[])[];
    expect(ramp[0]).toBe('interpolate');
    const stops = ramp.slice(3).filter((_, i) => i % 2 === 1) as number[];
    for (const opacity of stops) expect(opacity).toBeGreaterThanOrEqual(0.7);
  });
});

// ── palette ───────────────────────────────────────────────────────────────────
//
// FOUR colors are now on screen: the selected segment (strong blue), the rest of
// the composite (light blue), the backdrop (gray) and jobs (orange). What survives
// from the old three-color palette is the METRIC: validate with ΔE2000, never
// CIE76. CIE76 overstates separation in the blue region, and that is exactly how a
// discarded four-hue ramp shipped once: it scored its worst pair 21.1 and waved it
// through, where ΔE2000 puts the same pair at 10.8 — in the fail band.

/** sRGB hex → linear RGB. */
function toLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

/** Machado, Oliveira & Fernandes (2009) CVD transforms, severity 1.0, linear RGB. */
const MACHADO: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

type Vision = 'normal' | 'protan' | 'deutan' | 'tritan';

/** hex → CIE Lab (D65), as seen under `vision`. */
function toLab(hex: string, vision: Vision): [number, number, number] {
  const v = toLinear(hex);
  const [r, g, b] = vision === 'normal'
    ? v
    : (MACHADO[vision].map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as [number, number, number]);
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X / 0.95047), fy = f(Y / 1), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000. */
function deltaE2000(hexA: string, hexB: string, vision: Vision): number {
  const [L1, a1, b1] = toLab(hexA, vision);
  const [L2, a2, b2] = toLab(hexB, vision);
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const d = (Math.atan2(y, x) * 180) / Math.PI;
    return d < 0 ? d + 360 : d;
  };
  const h1p = hue(a1p, b1), h2p = hue(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else {
    const sum = h1p + h2p;
    if (Math.abs(h1p - h2p) > 180) hbp = sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
    else hbp = sum / 2;
  }
  const T = 1
    - 0.17 * Math.cos(((hbp - 30) * Math.PI) / 180)
    + 0.24 * Math.cos((2 * hbp * Math.PI) / 180)
    + 0.32 * Math.cos(((3 * hbp + 6) * Math.PI) / 180)
    - 0.20 * Math.cos(((4 * hbp - 63) * Math.PI) / 180);
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin((60 * Math.exp(-(((hbp - 275) / 25) ** 2)) * Math.PI) / 180)
    * 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}


const VISIONS: Vision[] = ['normal', 'protan', 'deutan', 'tritan'];

describe('palette — the four-way separation (ΔE2000, Machado-2009 CVD)', () => {
  it('SANITY-CHECKS THE METRIC against the pair that sank the old ramp', () => {
    // A wrong ΔE2000 is worse than no ΔE2000: it launders a bad palette. This
    // implementation was validated against the Sharma et al. CIEDE2000 reference
    // vectors (2.0425 / 2.8615 / 3.4412, matched to 4 decimals) when the fourth
    // color was chosen; what is pinned here is the behaviour that MATTERS —
    // blue↔violet, the old slot-0/slot-1 pair. CIE76 scores it 21.1 and waves it
    // through; ΔE2000 puts it at 10.8 under deuteranopia, inside the fail band.
    // Keep this so the next person to reach for a color check reaches for the
    // right metric.
    expect(deltaE2000('#2563eb', '#6A3D9A', 'normal')).toBeCloseTo(19.6, 0);
    expect(deltaE2000('#2563eb', '#6A3D9A', 'deutan')).toBeCloseTo(10.8, 0);
  });

  it('pins the four colors', () => {
    expect(SEGMENT_COLOR).toBe('#2563eb');
    expect(COMPOSITE_COLOR).toBe('#60a5fa');
    expect(BACKDROP_COLOR).toBe('#9ca3af');
    expect(JOBS_COLOR).toBe('#f97316');
  });

  it('keeps the all-pairs floor above ΔE2000 15 under every vision type', () => {
    // Measured floor is 17.69 (composite↔backdrop, normal vision). The old
    // THREE-color palette floored at 27.0; a fourth color can only lower that, and
    // this is the honest cost. 17.69 is still 2.2x the ΔE 8 hard-fail band and
    // clear of the ΔE 12 warn band. The threshold is set below the measured value
    // so a retune that collapses the separation fails loudly.
    const onScreen = [SEGMENT_COLOR, COMPOSITE_COLOR, BACKDROP_COLOR, JOBS_COLOR];
    let floor = Infinity;
    for (let i = 0; i < onScreen.length; i++) {
      for (let j = i + 1; j < onScreen.length; j++) {
        for (const v of VISIONS) {
          floor = Math.min(floor, deltaE2000(onScreen[i], onScreen[j], v));
        }
      }
    }
    expect(floor).toBeGreaterThan(15);
    expect(floor).toBeCloseTo(17.69, 1);
  });

  it('holds the muted composite APART FROM THE GRAY — the pair the fix depends on', () => {
    // These are precisely the people the old schema drew nowhere. If the muted
    // tone reads as "everyone else", the lie is back in a different medium.
    for (const v of VISIONS) {
      expect(deltaE2000(COMPOSITE_COLOR, BACKDROP_COLOR, v)).toBeGreaterThan(15);
    }
  });

  it('holds the muted composite apart from the segment blue', () => {
    for (const v of VISIONS) {
      expect(deltaE2000(COMPOSITE_COLOR, SEGMENT_COLOR, v)).toBeGreaterThan(15);
    }
  });

  it('keeps the muted tone LIGHTER than the segment, so it recedes behind it', () => {
    // Salience order must be segment > composite > backdrop. Lightness carries it.
    // A grid search maximizing the ΔE floor prefers a DARK indigo (#584f65, floor
    // 21.9) — rejected on purpose: at L* 35 it is the heaviest ink on a light
    // basemap and would out-shout the role the user actually selected.
    const L = (hex: string) => toLab(hex, 'normal')[0];
    expect(L(COMPOSITE_COLOR)).toBeGreaterThan(L(SEGMENT_COLOR));
    expect(L('#584f65')).toBeLessThan(L(SEGMENT_COLOR));   // why it was rejected
  });

  it('holds the jobs orange apart from all three', () => {
    for (const v of VISIONS) {
      expect(deltaE2000(JOBS_COLOR, SEGMENT_COLOR, v)).toBeGreaterThan(50);
      expect(deltaE2000(JOBS_COLOR, COMPOSITE_COLOR, v)).toBeGreaterThan(45);
      expect(deltaE2000(JOBS_COLOR, BACKDROP_COLOR, v)).toBeGreaterThan(29);
    }
  });

  it('maps each role to its color', () => {
    expect(ROLE_COLORS).toEqual({
      segment: SEGMENT_COLOR,
      composite: COMPOSITE_COLOR,
      backdrop: BACKDROP_COLOR,
      jobs: JOBS_COLOR,
    });
  });
});

describe('mode metadata', () => {
  it('names both modes and their composites', () => {
    expect(DEMAND_MODES.map((m) => m.id)).toEqual(['propensity', 'need']);
    expect(demandModeDef('propensity').composite).toEqual(['carless', 'low_income']);
    expect(demandModeDef('need').composite).toEqual([
      'carless', 'low_income', 'senior', 'disability',
    ]);
  });

  it('frames the composites as estimates, not headcounts', () => {
    for (const m of DEMAND_MODES) {
      expect(m.allHint.toLowerCase()).toMatch(/estimate|de-duplicated/);
    }
  });

  it('gives the muted role a label that says the people are still there', () => {
    for (const m of DEMAND_MODES) {
      expect(m.restLabel).toBeTruthy();
      expect(m.restLabel).not.toMatch(/everyone else/i);
      expect(m.restHint.toLowerCase()).toContain('not in the group you selected');
    }
  });

  it('cites a straight ACS table for each segment', () => {
    for (const s of DEMAND_SEGMENTS) expect(s.hint).toMatch(/ACS [A-Z]\d+/);
  });

  it('exhaustively covers the DemandMode union', () => {
    const ids: DemandMode[] = ['propensity', 'need'];
    for (const id of ids) expect(demandModeDef(id).id).toBe(id);
  });
});
