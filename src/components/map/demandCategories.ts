// Demand dots: the tile schema, the SELECTION MODEL, the palette, and the pure
// Mapbox expression builders behind the single vector-tile circle layer.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DOT IS A PERSON, NOT A MEMBERSHIP
//
// Every population dot in the tiles is ONE PERSON carrying four boolean flags,
// packed into a single integer attribute `d` (bit 1 carless, 2 low_income,
// 4 senior, 8 disability; so d is 0-15). Jobs are a separate universe with their
// own code (16) — a job is not a person and is never mixed into the population.
//
// So the UI RECOLORS; it never reclasses. Changing mode or segment changes the
// COLOR EXPRESSION over the same dots. Nothing is refetched, and — the point —
// every person stays on screen in every view.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUG THIS SCHEMA EXISTS TO KILL
//
// The tiles used to carry a separate CLASS per segment, plus composite classes
// (prop_all / need_all) and backdrop classes (backdrop_prop / backdrop_need).
// With the Carless segment selected, the map drew:
//
//     carless                                    (blue)
//   + population − (carless ∪ low_income)        (gray, class `backdrop_prop`)
//
// Look at what is missing. The backdrop was population minus the COMPOSITE, not
// population minus the SELECTION — so the low-income-but-not-carless people,
// ~24% of the population, were drawn NOWHERE AT ALL. Nothing was double-counted,
// so every invariant passed; a quarter of the town simply vanished, and a
// planner reading gray as "everyone else in town" was misled.
//
// Now the three roles are computed from the flags at render time and they
// PARTITION the population by construction:
//
//     segment    the flag you selected                        strong blue
//     composite  in the mode's composite, but NOT that flag   muted indigo
//     backdrop   in neither                                   gray
//
//     segment ∪ composite ∪ backdrop == every population dot, always.
//
// With ALL selected there is no `composite` role: every composite member IS the
// selection, so it is blue, and everyone else is gray. Same partition.
//
// This is why `senior` and `disability` are absent from PROPENSITY mode. They
// are not in the propensity composite (carless ∪ low_income), so selecting
// `senior` there would paint car-owning seniors as likely riders. The type
// system enforces it — `PropensitySegment` has no 'senior' member, so
// `{ mode: 'propensity', segment: 'senior' }` DOES NOT COMPILE. Keep it that way.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PALETTE — four roles, and an honest ΔE2000 floor
//
// At most four colors are ever on screen, and their roles are fixed:
//
//   segment    strong blue   #2563eb   the flag you selected
//   composite  light blue    #60a5fa   the REST of the composite: present, secondary
//   backdrop   neutral gray  #9ca3af   a remainder — deliberately low-chroma
//   jobs       orange        #f97316   a different unit, so it keeps its own color
//
// All-pairs ΔE2000 (Machado-2009 CVD simulation at severity 1.0):
//
//   pair                     normal   protan   deutan   tritan
//   ----------------------------------------------------------
//   segment-composite       21.3701  18.2177  21.0266  18.5074
//   segment-jobs            55.2103  61.8949  69.1119  90.5281
//   segment-backdrop        27.0343  26.9992  31.6415  27.6208
//   composite-jobs          50.1874  56.0548  58.3448  62.4578
//   composite-backdrop      17.6873  17.7650  18.6732  19.5272   ← the floor
//   backdrop-jobs           34.3600  34.8270  35.1113  29.9543
//   ----------------------------------------------------------
//   FLOOR = 17.69   (composite vs backdrop, normal vision)
//
// STATE THE COST HONESTLY: the old three-color palette floored at ΔE2000 27.0. A
// fourth color cannot RAISE that floor, only lower it, and this one lowers it to
// 17.7 — a real cost of 9.3. It is still 2.2x the ΔE 8 hard-fail band and clear of
// the ΔE 12 warn band under every vision type. The alternative was not a better
// palette; it was leaving a quarter of the population undrawn, which is not a
// color problem, it is a lie.
//
// WHY NOT THE COLOR WITH THE BEST FLOOR. A grid search maximizing the all-pairs
// floor picks a DARK slate-indigo (#584f65, floor 21.9) over this. It was
// rejected on purpose: at L* 35 it is DARKER than the segment blue (L* 46), so on
// a light basemap it is the heaviest ink on the map — the muted "you didn't pick
// these" role would visually out-shout the role the user actually selected. The
// salience order has to be segment > composite > backdrop, and lightness is what
// carries that. #60a5fa is the best-scoring color that is LIGHTER than the segment
// blue and still chromatic enough not to collapse into the gray; the light-blue
// region tops out around ΔE 18, so 17.7 is very near the best available under that
// (non-negotiable) constraint.
//
// NOTE THE METRIC. Validate with ΔE2000, NEVER CIE76. CIE76 overstates separation
// in the blue region: it is exactly how a bad four-hue ramp shipped once before
// (CIE76 scored its worst pair 21.1 and waved it through; ΔE2000 puts that same
// pair at 10.8, inside the fail band). The palette tests pin all of the above,
// including a check of the ΔE2000 implementation itself against the Sharma et al.
// reference pairs — a wrong metric is worse than no metric.

import type {
  DataDrivenPropertyValueSpecification,
  FilterSpecification,
} from 'mapbox-gl';

// ── the tile schema ──────────────────────────────────────────────────────────
//
// These MUST equal the pipeline's (build_dots.FLAG_BITS / JOBS_CODE). They are
// not merely documented there — demandLegend.ts reads the pipeline's own values
// out of demand-legend.json and REFUSES TO START if they disagree with these,
// because Mapbox GL has no bitwise operators and every filter below is an
// enumeration built from these bits. A silent mismatch would not break the map;
// it would draw the wrong people, plausibly.

/** The tile attribute every dot carries. Integer: 0-15 population, 16 jobs. */
export const DEMAND_ATTR = 'd';

export type DemandFlag = 'carless' | 'low_income' | 'senior' | 'disability';

export const FLAG_BITS = {
  carless: 1,
  low_income: 2,
  senior: 4,
  disability: 8,
} as const satisfies Record<DemandFlag, number>;

/** Canonical flag order (bit order). */
export const DEMAND_FLAGS: readonly DemandFlag[] = [
  'carless',
  'low_income',
  'senior',
  'disability',
] as const;

/** One past the population codes: a job. */
export const JOBS_CODE = 16;

/** Every population code: 0 (no flags) through 15 (all four). */
export const POPULATION_CODES: readonly number[] = Array.from({ length: 16 }, (_, i) => i);

/** Every code the tiles can carry. */
export const DEMAND_CODES: readonly number[] = [...POPULATION_CODES, JOBS_CODE];

/** Does population code `code` carry `flag`? The bitwise test, done in TS. */
export function codeHasFlag(code: number, flag: DemandFlag): boolean {
  return (code & FLAG_BITS[flag]) !== 0;
}

/** The flags a code carries — for tests and tooltips, never for the tiles. */
export function flagsOfCode(code: number): DemandFlag[] {
  return DEMAND_FLAGS.filter((f) => codeHasFlag(code, f));
}

// ── the selection model ──────────────────────────────────────────────────────

export type DemandMode = 'propensity' | 'need';

/**
 * The segments offered in PROPENSITY mode: exactly the flags the propensity
 * composite is the union OF. Adding an id here is a claim that a person with
 * that flag has elevated ridership propensity — if that is false, selecting it
 * would paint people the composite does not contain, and the composite/backdrop
 * split below would stop being a partition. The pipeline states its own version
 * of this in the legend's `modes` block and demandLegend.ts refuses to run if
 * the two disagree.
 */
const PROPENSITY_SEGMENT_IDS = ['carless', 'low_income'] as const satisfies readonly DemandFlag[];

type PropensitySegmentId = (typeof PROPENSITY_SEGMENT_IDS)[number];

/** `'all'` is the composite radio; the rest are the straight-ACS flags. */
export type PropensitySegment = 'all' | PropensitySegmentId;
export type NeedSegment = 'all' | DemandFlag;
/** Any segment id the UI can name. Need mode is the superset. */
export type DemandSegment = NeedSegment;

/**
 * Mode + the one selected segment, as a discriminated union — so an illegal
 * pairing is a TYPE ERROR, not a runtime check:
 *
 *   const bad: DemandSelection =
 *     { mode: 'propensity', segment: 'senior', jobs: true, backdrop: true };
 *   //                      ~~~~~~~~ Type '"senior"' is not assignable to
 *   //                               type 'PropensitySegment'
 *
 * `segment` is a single value, not a set. Under the old schema that was what
 * prevented double-counting; it now prevents something subtler — two segments at
 * once would need two "strong" colors and a composite remainder defined against
 * both, and there is no honest four-role partition for that.
 */
export type DemandSelection =
  | {
      readonly mode: 'propensity';
      readonly segment: PropensitySegment;
      readonly jobs: boolean;
      readonly backdrop: boolean;
    }
  | {
      readonly mode: 'need';
      readonly segment: NeedSegment;
      readonly jobs: boolean;
      readonly backdrop: boolean;
    };

/** Propensity + the composite + both companions on: the map's opening view. */
export const DEFAULT_DEMAND_SELECTION: DemandSelection = {
  mode: 'propensity',
  segment: 'all',
  jobs: true,
  backdrop: true,
};

// ── mode + segment metadata ──────────────────────────────────────────────────

export interface DemandModeDef {
  id: DemandMode;
  label: string;
  hint: string;
  /** The flags this mode's composite is the union of. */
  composite: readonly DemandFlag[];
  /** The ALL radio's label + hint. */
  allLabel: string;
  allHint: string;
  /** Label for the muted "in the composite, but not the flag you picked" role. */
  restLabel: string;
  restHint: string;
  backdropHint: string;
}

export const DEMAND_MODES: readonly DemandModeDef[] = [
  {
    id: 'propensity',
    label: 'Ridership propensity',
    hint: 'Who is most likely to ride transit if it is available to them',
    composite: ['carless', 'low_income'],
    allLabel: 'All likely riders',
    allHint:
      'Everyone with elevated ridership propensity, de-duplicated. A PUMS-derived statistical estimate — not a headcount.',
    restLabel: 'Other likely riders',
    restHint:
      'Likely riders who are not in the group you selected. They are still on the map — drawn in a muted tone — because they are not "everyone else".',
    backdropHint: 'Residents outside the likely-rider estimate — the neutral backdrop',
  },
  {
    id: 'need',
    label: 'Transit need',
    hint: 'Who depends on transit — people for whom no car, low income, age or disability limits other options',
    composite: ['carless', 'low_income', 'senior', 'disability'],
    allLabel: 'Everyone with transit need',
    allHint:
      'Carless, low-income, senior and disabled residents, de-duplicated. A PUMS-derived statistical estimate — not a headcount.',
    restLabel: 'Others with transit need',
    restHint:
      'People with transit need who are not in the group you selected. They are still on the map — drawn in a muted tone — because they are not "everyone else".',
    backdropHint: 'Residents outside the transit-need estimate — the neutral backdrop',
  },
] as const;

const MODE_BY_ID = new Map<DemandMode, DemandModeDef>(DEMAND_MODES.map((m) => [m.id, m]));

export function demandModeDef(mode: DemandMode): DemandModeDef {
  const def = MODE_BY_ID.get(mode);
  // Unreachable while DEMAND_MODES covers the union; kept so the lookup is total.
  if (!def) throw new Error(`unknown demand mode "${mode}"`);
  return def;
}

/** The bitmask of a mode's composite — the OR of its flags' bits. */
export function compositeBits(mode: DemandMode): number {
  return demandModeDef(mode).composite.reduce((acc, f) => acc | FLAG_BITS[f], 0);
}

export interface DemandSegmentDef {
  id: DemandFlag;
  label: string;
  hint: string;
  /** The modes whose composite contains this flag. */
  modes: readonly DemandMode[];
}

/**
 * The four ACS flags. Every one is a STRAIGHT ACS COUNT (a table lookup,
 * apportioned to blocks) — unlike the composites, which are PUMS-derived
 * estimates. The UI leans on that distinction, so keep it accurate.
 */
export const DEMAND_SEGMENTS: readonly DemandSegmentDef[] = [
  {
    id: 'carless',
    label: 'Carless',
    hint: 'People in households with no vehicle available (ACS B25044)',
    modes: ['propensity', 'need'],
  },
  {
    id: 'low_income',
    label: 'Low income',
    hint: 'People under 200% of the federal poverty line (ACS C17002)',
    modes: ['propensity', 'need'],
  },
  {
    id: 'senior',
    label: 'Seniors 65+',
    hint: 'Adults aged 65 and over (ACS B01001)',
    modes: ['need'],
  },
  {
    id: 'disability',
    label: 'Disability',
    hint: 'Civilian adults 18+ living with a disability (ACS C21007)',
    modes: ['need'],
  },
] as const;

/**
 * Type predicate, and the single runtime gate on selectability. It tests the same
 * PROPENSITY_SEGMENT_IDS list the `PropensitySegment` type is derived from — one
 * source of truth, so the compiler and the runtime cannot disagree.
 */
export function isPropensitySegment(segment: DemandSegment): segment is PropensitySegment {
  return segment === 'all' || (PROPENSITY_SEGMENT_IDS as readonly string[]).includes(segment);
}

/**
 * Can `segment` be shown in `mode`? True only when the mode's composite contains
 * it. `senior`/`disability` are therefore need-only: showing them in propensity
 * mode would paint a car-owning senior as a likely rider.
 */
export function isSegmentSelectable(mode: DemandMode, segment: DemandSegment): boolean {
  return mode === 'propensity' ? isPropensitySegment(segment) : true;
}

/** The segments a mode offers, in canonical order (the ALL radio is separate). */
export function segmentsForMode(mode: DemandMode): DemandSegmentDef[] {
  return DEMAND_SEGMENTS.filter((s) => s.modes.includes(mode));
}

/** True when the selected radio is the composite (a statistical estimate). */
export function isCompositeSelected(sel: DemandSelection): boolean {
  return sel.segment === 'all';
}

// ── selection → render role ──────────────────────────────────────────────────

/**
 * What a dot is drawn AS. The four roles partition every dot on screen, and the
 * three population roles partition the whole resident population — that is the
 * property the layer exists to have.
 */
export type DemandRole = 'segment' | 'composite' | 'backdrop' | 'jobs';

/**
 * THE WHOLE MODEL, in one function: which role a tile code plays under a given
 * selection, or null when it is not drawn at all.
 *
 * Only two things can be undrawn, and both are explicit user choices: the
 * backdrop (unchecked) and jobs (unchecked). NOTHING ELSE CAN EVER BE NULL for a
 * population code — that is checked by a test that walks all 16 codes × every
 * selection, because "a person who is drawn in no role" is precisely the bug the
 * old class-per-segment schema had.
 */
export function roleForCode(sel: DemandSelection, code: number): DemandRole | null {
  if (code === JOBS_CODE) return sel.jobs ? 'jobs' : null;

  const inComposite = (code & compositeBits(sel.mode)) !== 0;
  // With ALL selected the selection IS the composite. With a flag selected, the
  // selection is that flag — and it is necessarily inside the composite, because
  // a flag is only offered in a mode whose composite contains it (the
  // PropensitySegment type is what enforces that, at compile time).
  const inSegment =
    sel.segment === 'all' ? inComposite : (code & FLAG_BITS[sel.segment]) !== 0;

  if (inSegment) return 'segment';
  if (inComposite) return 'composite';
  return sel.backdrop ? 'backdrop' : null;
}

/** The codes drawn in each role under `sel`. Pure; drives the filter and color. */
export function codesByRole(sel: DemandSelection): Record<DemandRole, number[]> {
  const out: Record<DemandRole, number[]> = {
    segment: [],
    composite: [],
    backdrop: [],
    jobs: [],
  };
  for (const code of DEMAND_CODES) {
    const role = roleForCode(sel, code);
    if (role) out[role].push(code);
  }
  return out;
}

/** Every code on screen under `sel`. */
export function activeDemandCodes(sel: DemandSelection): number[] {
  return DEMAND_CODES.filter((code) => roleForCode(sel, code) !== null);
}

/** The roles that actually have dots under `sel`, in draw/legend order. */
export function activeDemandRoles(sel: DemandSelection): DemandRole[] {
  const byRole = codesByRole(sel);
  return (['segment', 'composite', 'backdrop', 'jobs'] as const).filter(
    (r) => byRole[r].length > 0,
  );
}

// ── transitions (the only legal ways to move the selection) ──────────────────

/**
 * Switch mode, carrying the segment over when the target mode's composite also
 * contains it (Carless and Low income mean the same person set in both modes). A
 * need-only segment cannot survive a switch to propensity, so it falls back to
 * the composite — the narrowing below is not defensive, it IS the enforcement.
 */
export function setDemandMode(sel: DemandSelection, mode: DemandMode): DemandSelection {
  if (sel.mode === mode) return sel;
  if (mode === 'propensity') {
    const segment: PropensitySegment = isPropensitySegment(sel.segment) ? sel.segment : 'all';
    return { mode: 'propensity', segment, jobs: sel.jobs, backdrop: sel.backdrop };
  }
  return { mode: 'need', segment: sel.segment, jobs: sel.jobs, backdrop: sel.backdrop };
}

/**
 * Pick the radio. A segment the current mode does not contain is REFUSED (the
 * selection is returned unchanged) rather than silently coerced — the UI never
 * offers it in the first place, so reaching this means a bug upstream, and
 * quietly showing a different layer than the one that was clicked would hide it.
 */
export function setDemandSegment(sel: DemandSelection, segment: DemandSegment): DemandSelection {
  if (sel.mode === 'propensity') {
    if (!isPropensitySegment(segment)) return sel;
    return { mode: 'propensity', segment, jobs: sel.jobs, backdrop: sel.backdrop };
  }
  return { mode: 'need', segment, jobs: sel.jobs, backdrop: sel.backdrop };
}

/** Toggle the Jobs checkbox (workplace universe — always safe beside anything). */
export function setDemandJobs(sel: DemandSelection, jobs: boolean): DemandSelection {
  return sel.mode === 'propensity' ? { ...sel, jobs } : { ...sel, jobs };
}

/** Toggle the "Everyone else" backdrop checkbox. */
export function setDemandBackdrop(sel: DemandSelection, backdrop: boolean): DemandSelection {
  return sel.mode === 'propensity' ? { ...sel, backdrop } : { ...sel, backdrop };
}

// ── palette ──────────────────────────────────────────────────────────────────

/** The selected segment, whichever it is. Only one is ever on screen. */
export const SEGMENT_COLOR = '#2563eb';
/**
 * The rest of the composite — in the group, but not the flag you picked.
 *
 * The same hue as the segment blue and LIGHTER than it, so it reads as "these are
 * also in the group, just not the ones you asked for" and recedes behind the
 * selection instead of competing with it. It must never read as the gray: these
 * are exactly the people the old schema drew NOWHERE, and washing them into
 * "everyone else" would reintroduce the lie in a different medium.
 */
export const COMPOSITE_COLOR = '#60a5fa';
/** The remainder. Deliberately low-chroma: it recedes, it is not a series. */
export const BACKDROP_COLOR = '#9ca3af';
/** Jobs — a different unit, so it keeps its own color beside any segment. */
export const JOBS_COLOR = '#f97316';

export const ROLE_COLORS: Record<DemandRole, string> = {
  segment: SEGMENT_COLOR,
  composite: COMPOSITE_COLOR,
  backdrop: BACKDROP_COLOR,
  jobs: JOBS_COLOR,
};

export function roleColor(role: DemandRole): string {
  return ROLE_COLORS[role];
}

// ── Mapbox expressions ───────────────────────────────────────────────────────
//
// Both of these are ENUMERATIONS over the integer codes, because Mapbox GL
// expressions have no bitwise operators — there is no way to write "where bit 1
// is set". There does not need to be: four flags make sixteen codes, the set
// matching any predicate over them is computable here, and sixteen literals is a
// perfectly cheap filter.

/**
 * The filter: the codes currently on screen. Only the LAYER changes when the
 * selection does — the source is untouched, so no tiles are refetched.
 */
export function buildDemandFilter(sel: DemandSelection): FilterSpecification {
  return ['in', ['get', DEMAND_ATTR], ['literal', activeDemandCodes(sel)]];
}

/**
 * circle-color: a `match` from code → the color of the role that code plays under
 * this selection. Selection-DEPENDENT, unlike the old static class→color map —
 * that is the whole point of attribute dots (the same dot is blue in one view and
 * muted in another), and it costs one setPaintProperty against already-loaded
 * tiles.
 *
 * The fallback is the backdrop gray: it is only reachable by a code the filter
 * already excluded, so it paints nothing — but a `match` must have a default, and
 * a loud color there would turn any future schema drift into a screen of garbage
 * rather than a quiet nothing.
 */
export function buildDemandColor(sel: DemandSelection): DataDrivenPropertyValueSpecification<string> {
  const byRole = codesByRole(sel);
  const branches: (number | string)[] = [];
  for (const role of ['segment', 'composite', 'backdrop', 'jobs'] as const) {
    for (const code of byRole[role]) branches.push(code, ROLE_COLORS[role]);
  }
  return [
    'match',
    ['get', DEMAND_ATTR],
    ...branches,
    BACKDROP_COLOR,
  ] as unknown as DataDrivenPropertyValueSpecification<string>;
}

/**
 * circle-opacity: a plain zoom ramp. Zoomed-out dots stay a touch softer than
 * zoomed-in ones because there are many more of them on screen: the ladder halves
 * the stride with each zoom step while the viewport quarters, so z8 is the
 * DENSEST view, not the emptiest.
 */
export const DEMAND_CIRCLE_OPACITY: DataDrivenPropertyValueSpecification<number> = [
  'interpolate',
  ['linear'],
  ['zoom'],
  8, 0.75,
  10, 0.8,
  13, 0.85,
  15, 0.85,
] as unknown as DataDrivenPropertyValueSpecification<number>;
