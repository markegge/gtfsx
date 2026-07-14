// The demand-dot legend: the TILE SCHEMA (flag bits, jobs code), the dot density,
// the zoom→sampling ladder, and the tile archive name — all read straight from the
// pipeline's own `demand-dots/demand-legend.json` rather than hand-copied here.
// The numbers belong to the pipeline; copying them into the frontend is only ever
// one pipeline edit away from lying.
//
// Imported as raw text (Vite's `?raw` loader, typed by `vite/client`) rather than
// a JSON import: the legend lives outside `src/`, and a typed
// `import x from '*.json'` would need `resolveJsonModule`, which is repo-wide
// tsconfig config out of scope here. `?raw` needs no tsconfig change and still
// fails the BUILD (not just a lint) if the file moves or the JSON is malformed.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FLAG BITS ARE CHECKED, NOT ASSUMED
//
// Mapbox GL expressions have NO BITWISE OPERATORS. The frontend cannot ask the
// tiles for "dots where bit 1 is set" — it has to ENUMERATE the matching codes
// (demandCategories.codesByRole) from bit values it holds locally. If those bits
// ever disagreed with the ones the pipeline packed into the tiles, nothing would
// crash and nothing would look broken: the map would simply color the WRONG
// PEOPLE, plausibly, forever. So the legend's `flags`, `jobs_code` and
// `attribute` are verified against the frontend's model at import, and a mismatch
// THROWS — failing the build and CI.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO FAILURE MODES, DELIBERATELY TREATED DIFFERENTLY
//
// 1. DRIFT / SCHEMA SHIFT — the legend is the new schema but its bits, composites
//    or ladder disagree with ours. That is a bug between two halves of one
//    feature, and the only safe response is to FAIL LOUDLY at import. A wrong
//    "1 dot ≈ N", or a filter over the wrong bits, is worse than no map — it is a
//    number a planner would put in a memo.
//
// 2. PRE-ATTRIBUTE-DOTS LEGEND — the legend is an OLDER SCHEMA entirely (a
//    `classes` map with `prop_all` / `backdrop_prop` / …) because the new tileset
//    has not been built yet. That is not drift, it is a known interim: the tiles
//    genuinely do not carry a `d` attribute, so the layer would draw nothing. We
//    detect it, disable the feature, and say why (DEMAND_UNAVAILABLE_REASON),
//    instead of either crashing the editor or rendering a confusing blank overlay.
//
// The two are pinned against each other by demandLegend.test.ts.
import legendRaw from '../../../demand-dots/demand-legend.json?raw';
import {
  DEMAND_ATTR,
  DEMAND_FLAGS,
  DEMAND_MODES,
  DEMAND_SEGMENTS,
  FLAG_BITS,
  JOBS_CODE,
  activeDemandRoles,
  codesByRole,
  demandModeDef,
  roleColor,
  segmentsForMode,
  type DemandFlag,
  type DemandRole,
  type DemandSelection,
} from './demandCategories';

// ── the schema the pipeline emits ────────────────────────────────────────────
//
// `zoom_ladder.strides` maps TILE ZOOM → STRIDE: at zoom z the tiles carry every
// stride(z)-th dot, so what one dot on screen is worth is
//
//     1 dot ≈ per_dot × stride(tile zoom)   people (or jobs)
//
// and stride is 1 at or beyond `full_density_zoom`, where every dot is present.
// (The pipeline bakes this into the tiles as a per-feature minzoom — it can't be
// a client-side filter, because Mapbox GL forbids ["zoom"] inside filters. So the
// frontend only ever REPORTS the ratio; it never applies it.)
//
// Strides are denominators (1-in-N), never keep-fractions: a fraction would divide
// rather than multiply the ratio and tell a planner a zoomed-out dot is worth
// FEWER people than a zoomed-in one — the exact inversion of the truth. The parser
// rejects that loudly rather than render it.
//
// The ratio this file computes is only true if THE STRIDE IS THE ONLY THINNING.
// That is a property of the BUILD, not of this file, and it quietly broke once:
// tippecanoe's default --drop-rate threw away a further 40x at z8 ON TOP of the
// ladder, so the legend said "1 dot ≈ 40 people" over tiles that carried one dot
// per ~1,850. The pipeline now builds with --drop-rate=1 and a tile budget the
// ladder never exceeds, and demand-dots/verify_tiles.py re-decodes the archive to
// prove retained == emitted for every zoom and every code.

/** The zoom→stride ladder, as the pipeline emits it. */
export interface DemandZoomLadder {
  /** Tile zoom → stride ("the tiles carry every Nth dot at this zoom"). */
  strides: ReadonlyMap<number, number>;
  /** At or beyond this zoom every dot is present (stride 1). */
  fullDensityZoom: number;
}

/** A dot universe: the population, or jobs. Two grains, nothing else. */
export interface DemandUnit {
  label: string;
  description: string;
  /** "people" or "jobs". */
  unit: string;
  /** Things-per-dot at FULL density (i.e. at the deepest zoom). */
  perDot: number;
}

/** One of the four flags, as the pipeline describes it. */
export interface DemandFlagInfo {
  bit: number;
  label: string;
  description: string;
  modes: readonly string[];
}

export interface DemandLegend {
  /**
   * Tile archive the dots live in — the `{archive}` in
   * /_demand-tiles/{archive}/{z}/{x}/{y}.pbf. Read from the legend when the
   * pipeline emits it, so a rebuild under a new archive name needs no frontend
   * edit. Null when it doesn't (see DemandDotsLayer for the fallback chain).
   */
  archive: string | null;
  sourceLayer: string;
  /** The integer attribute every dot carries. Must be DEMAND_ATTR. */
  attribute: string;
  minZoom: number;
  maxZoom: number;
  ladder: DemandZoomLadder;
  population: DemandUnit;
  jobs: DemandUnit;
  flags: Readonly<Record<DemandFlag, DemandFlagInfo>>;
}

export type DemandLegendState =
  | { status: 'ok'; legend: DemandLegend }
  /** An older schema/tileset. Feature disabled, with a reason. */
  | { status: 'stale'; reason: string };

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`demand-legend.json: ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`demand-legend.json: ${what} must be a finite number, got ${String(value)}`);
  }
  return value;
}

/**
 * Parse `zoom_ladder`. Without it the legend cannot state an honest "1 dot ≈ N",
 * so its absence is fatal — do NOT "fix" a throw here by defaulting the strides
 * to 1, which would understate what a zoomed-out dot is worth by up to 128x.
 */
function parseZoomLadder(raw: Record<string, unknown>): DemandZoomLadder {
  if (raw.zoom_ladder === undefined) {
    throw new Error(
      'demand-legend.json is missing `zoom_ladder` — the frontend cannot state an honest ' +
        '"1 dot ≈ N" without the pipeline\'s zoom→density ladder. Expected ' +
        '{"strides": {"8": 128, "9": 64, …, "15": 1}, "full_density_zoom": 15}.',
    );
  }
  const ladder = asRecord(raw.zoom_ladder, '`zoom_ladder`');
  const rawStrides = asRecord(ladder.strides, '`zoom_ladder.strides`');

  const strides = new Map<number, number>();
  for (const [zoomKey, value] of Object.entries(rawStrides)) {
    const zoom = Number(zoomKey);
    if (!Number.isInteger(zoom)) {
      throw new Error(
        `demand-legend.json: \`zoom_ladder.strides\` key "${zoomKey}" is not an integer zoom`,
      );
    }
    const stride = num(value, `\`zoom_ladder.strides["${zoomKey}"]\``);
    if (stride < 1) {
      throw new Error(
        `demand-legend.json: \`zoom_ladder.strides["${zoomKey}"]\` is ${stride}. Strides are ` +
          'denominators ("the tiles carry every Nth dot"), so they are >= 1. A value below 1 ' +
          'looks like a keep-fraction — emit 8, not 0.125.',
      );
    }
    strides.set(zoom, stride);
  }
  if (strides.size === 0) throw new Error('demand-legend.json: `zoom_ladder.strides` is empty');

  const fullDensityZoom = num(ladder.full_density_zoom, '`zoom_ladder.full_density_zoom`');
  const atFull = strides.get(fullDensityZoom);
  if (atFull !== undefined && atFull !== 1) {
    throw new Error(
      `demand-legend.json: \`zoom_ladder\` says full density starts at z${fullDensityZoom}, but ` +
        `strides[${fullDensityZoom}] is ${atFull}, not 1.`,
    );
  }
  return { strides, fullDensityZoom };
}

/**
 * THE SCHEMA CHECK. Every client-side filter and color is an enumeration built
 * from these bit values (Mapbox GL has no bitwise operators), so a legend whose
 * bits disagree with ours does not break the map — it silently colors the wrong
 * people. Likewise the composites: if the pipeline moved `senior` into the
 * propensity composite, the muted "rest of the composite" role would start
 * including car-owning seniors and the mode would quietly mean something else.
 *
 * All of it is therefore verified, and a mismatch throws.
 */
function assertSchemaAgrees(raw: Record<string, unknown>): void {
  if (raw.attribute !== DEMAND_ATTR) {
    throw new Error(
      `demand-legend.json: the dots carry attribute "${String(raw.attribute)}", but the frontend ` +
        `reads "${DEMAND_ATTR}". Every filter would match nothing.`,
    );
  }
  if (raw.jobs_code !== JOBS_CODE) {
    throw new Error(
      `demand-legend.json: jobs_code is ${String(raw.jobs_code)}, but the frontend uses ` +
        `${JOBS_CODE}. Jobs would be drawn as people (or not at all).`,
    );
  }

  const flags = asRecord(raw.flags, '`flags`');
  for (const flag of DEMAND_FLAGS) {
    if (flags[flag] !== FLAG_BITS[flag]) {
      throw new Error(
        `demand-legend.json: flag "${flag}" has bit ${String(flags[flag])}, but the frontend ` +
          `enumerates its codes with bit ${FLAG_BITS[flag]}. Mapbox GL has no bitwise operators, ` +
          'so every filter is built from these bits — a mismatch does not break the map, it ' +
          'colors the WRONG PEOPLE. Reconcile demandCategories.ts with the pipeline.',
      );
    }
  }
  const extra = Object.keys(flags).filter((f) => !(DEMAND_FLAGS as readonly string[]).includes(f));
  if (extra.length > 0) {
    throw new Error(
      `demand-legend.json declares flag(s) the frontend does not know: ${extra.join(', ')}. ` +
        'They would be invisible — dots carrying only those flags would fall into the backdrop.',
    );
  }

  const modes = asRecord(raw.modes, '`modes`');
  for (const def of DEMAND_MODES) {
    const mode = asRecord(modes[def.id], `\`modes.${def.id}\``);
    const theirs = Array.isArray(mode.segments) ? [...(mode.segments as string[])].sort() : [];
    const ours = [...def.composite].sort();
    if (theirs.join(',') !== ours.join(',')) {
      throw new Error(
        `demand-legend.json: \`modes.${def.id}.segments\` is [${theirs.join(', ')}], but the ` +
          `frontend's ${def.id} composite is [${ours.join(', ')}]. The composite decides who is ` +
          'drawn as "the rest of the group" versus "everyone else" — if the two halves disagree, ' +
          'the map partitions the population differently than the pipeline believes it does.',
      );
    }
    // The radio list must match the composite: a segment offered in a mode whose
    // composite does NOT contain it would paint people outside the group as if
    // they were in it (a car-owning senior as a likely rider).
    const offered = segmentsForMode(def.id).map((s) => s.id).sort();
    if (offered.join(',') !== ours.join(',')) {
      throw new Error(
        `the frontend offers segments [${offered.join(', ')}] in ${def.id} mode but its composite ` +
          `is [${ours.join(', ')}]. Every selectable segment must be inside the composite.`,
      );
    }
  }
}

function parseUnit(raw: unknown, id: string): DemandUnit {
  const c = asRecord(raw, `unit "${id}"`);
  return {
    label: String(c.label ?? id),
    description: String(c.description ?? ''),
    unit: String(c.unit ?? 'people'),
    perDot: num(c.per_dot, `unit "${id}".per_dot`),
  };
}

/**
 * Pure parser — exported so the tests can drive it with fixtures instead of only
 * whatever happens to be on disk today.
 *
 * Throws on drift (wrong bits, wrong composites, a missing/ill-formed ladder).
 * Returns `stale` — not an exception — when the legend is an OLDER SCHEMA
 * entirely, because that state is expected until the new tileset lands and must
 * not break the editor.
 */
export function parseDemandLegend(raw: unknown): DemandLegendState {
  const root = asRecord(raw, 'root');

  // Older schemas had a `classes` map and no `flags`/`attribute`. That is not
  // drift — the tiles genuinely have no `d` attribute to filter on — so it
  // disables the layer with a reason rather than throwing.
  if (root.flags === undefined || root.attribute === undefined) {
    return {
      status: 'stale',
      reason:
        'The demand-dot tiles have not been rebuilt for the attribute-dot schema yet — ' +
        'demand-dots/demand-legend.json still describes the old one-class-per-segment ' +
        'vocabulary, whose tiles carry no per-dot membership flags.',
    };
  }

  assertSchemaAgrees(root);

  const units = asRecord(root.units, '`units`');
  const rawFlags = asRecord(root.flags, '`flags`');
  const segments = asRecord(root.segments, '`segments`');

  const flags = {} as Record<DemandFlag, DemandFlagInfo>;
  for (const flag of DEMAND_FLAGS) {
    const s = asRecord(segments[flag], `segment "${flag}"`);
    flags[flag] = {
      bit: num(rawFlags[flag], `flags.${flag}`),
      label: String(s.label ?? flag),
      description: String(s.description ?? ''),
      modes: Array.isArray(s.modes) ? (s.modes as string[]) : [],
    };
  }

  const archiveRaw = root.archive;
  return {
    status: 'ok',
    legend: {
      archive: typeof archiveRaw === 'string' && archiveRaw.length > 0 ? archiveRaw : null,
      sourceLayer: typeof root.source_layer === 'string' ? root.source_layer : 'demand',
      attribute: String(root.attribute),
      minZoom: num(root.min_zoom, '`min_zoom`'),
      maxZoom: num(root.max_zoom, '`max_zoom`'),
      ladder: parseZoomLadder(root),
      population: parseUnit(units.population, 'population'),
      jobs: parseUnit(units.jobs, 'jobs'),
      flags,
    },
  };
}

export const DEMAND_LEGEND_STATE: DemandLegendState = parseDemandLegend(
  JSON.parse(legendRaw) as unknown,
);

/** The legend, or null while the tiles are an older schema. */
export const DEMAND_LEGEND: DemandLegend | null =
  DEMAND_LEGEND_STATE.status === 'ok' ? DEMAND_LEGEND_STATE.legend : null;

/**
 * Which tile archive to fetch — the `{archive}` in
 * /_demand-tiles/{archive}/{z}/{x}/{y}.pbf.
 *
 * The pipeline should name it in the legend (`archive`), so a rebuild under a new
 * name needs no frontend edit; VITE_DEMAND_TILES_ARCHIVE overrides it for pointing
 * a dev build somewhere else. If NEITHER says where the tiles are, we do not
 * guess: an archive name that doesn't exist 404s every tile and paints an empty
 * overlay with no explanation, which is precisely the failure this state exists to
 * avoid. Null here disables the layer with a reason instead.
 */
const ENV_ARCHIVE = (import.meta.env.VITE_DEMAND_TILES_ARCHIVE as string | undefined)?.trim();
export const DEMAND_TILE_ARCHIVE: string | null =
  (ENV_ARCHIVE || DEMAND_LEGEND?.archive) ?? null;

/** False when the layer must not draw: no legend, or nowhere to fetch tiles from. */
export const DEMAND_DATA_READY = DEMAND_LEGEND !== null && DEMAND_TILE_ARCHIVE !== null;

/** Why the demand dots are unavailable, for the UI to show. Null when they aren't. */
export const DEMAND_UNAVAILABLE_REASON: string | null =
  DEMAND_LEGEND_STATE.status === 'stale'
    ? DEMAND_LEGEND_STATE.reason
    : DEMAND_TILE_ARCHIVE === null
      ? 'The demand-dot tiles for these categories have not been published yet — ' +
        'demand-dots/demand-legend.json does not name a tile `archive`.'
      : null;

if (!DEMAND_DATA_READY && DEMAND_UNAVAILABLE_REASON) {
  // Loud, but not fatal: these are known interim states (the pipeline is mid-flight),
  // not bugs. The UI disables the layer and shows the same reason, so nobody stares
  // at an empty map wondering what broke. Genuine drift throws above instead.
  console.warn(`[demand-dots] layer disabled — ${DEMAND_UNAVAILABLE_REASON}`);
}

// ── zoom → effective density ────────────────────────────────────────────────

/**
 * The tile zoom Mapbox will actually request at map zoom `zoom`: the integer
 * floor, clamped to the source's range (below minZoom nothing is mounted; past
 * maxZoom the deepest tiles are overzoomed and keep their own density).
 */
export function tileZoomFor(zoom: number, legend: DemandLegend): number {
  const z = Math.floor(zoom);
  if (z < legend.minZoom) return legend.minZoom;
  if (z > legend.maxZoom) return legend.maxZoom;
  return z;
}

/**
 * The stride in force at `zoom` — "the tiles carry every Nth dot here".
 *
 * The ladder is allowed to be sparse (the pipeline need only list the zooms where
 * the stride CHANGES), so the rung in force is the deepest one at or BELOW the
 * current tile zoom. Past `full_density_zoom` every dot is present, whether or not
 * the pipeline bothered to emit a rung for that zoom.
 */
export function strideAtZoom(zoom: number, legend: DemandLegend): number {
  const tileZoom = tileZoomFor(zoom, legend);
  if (tileZoom >= legend.ladder.fullDensityZoom) return 1;

  let best: number | null = null;
  let bestZoom = -Infinity;
  for (const [z, stride] of legend.ladder.strides) {
    if (z <= tileZoom && z > bestZoom) {
      bestZoom = z;
      best = stride;
    }
  }
  if (best !== null) return best;

  // Below every rung the pipeline emitted. Fall back to its SHALLOWEST stride
  // rather than inventing 1 — claiming full density where the tiles are sparsest
  // would understate what a dot is worth by the largest factor on the ladder.
  let shallowestZoom = Infinity;
  let shallowestStride = 1;
  for (const [z, stride] of legend.ladder.strides) {
    if (z < shallowestZoom) {
      shallowestZoom = z;
      shallowestStride = stride;
    }
  }
  return shallowestStride;
}

/**
 * The EFFECTIVE "1 dot ≈ N" for a role at the current map zoom. Every population
 * role shares one grain (a dot is a person, and people do not come in grains), so
 * this is really just "population or jobs" times the stride. It changes live as
 * the user zooms.
 */
export function perDotAtZoom(role: DemandRole, zoom: number, legend: DemandLegend): number {
  const unit = role === 'jobs' ? legend.jobs : legend.population;
  return Math.round(unit.perDot * strideAtZoom(zoom, legend));
}

/** 1234 → "1,234". Dot ratios get big when zoomed out; keep them readable. */
export function formatPerDot(n: number): string {
  return n.toLocaleString('en-US');
}

// ── the legend rows the control panel renders ────────────────────────────────

export interface DemandLegendRow {
  role: DemandRole;
  label: string;
  color: string;
  /** Effective people/jobs per dot AT THE CURRENT ZOOM. */
  perDot: number;
  unit: string;
  /** True for the composite radio: a PUMS-derived estimate, not a headcount. */
  isEstimate: boolean;
  /** True when nothing of this role is in the tile at the current zoom. */
  hiddenAtZoom: boolean;
}

/**
 * One row per ROLE currently on screen. At most four, and — for the three
 * population roles — a PARTITION of the resident population: the segment, the
 * rest of the composite, and everyone else. Jobs are a separate universe.
 *
 * There is no per-role minzoom any more. A flag rides on a person, and that
 * person is in the z8 tile on their own merits, so every segment is selectable at
 * every zoom the layer draws at. (The old schema held the segment classes back to
 * z9, so picking "Carless" while zoomed out drew nothing at all.) The only way to
 * see nothing now is to be below the SOURCE's minzoom, where no tiles are mounted.
 */
export function demandLegendRows(
  sel: DemandSelection,
  zoom: number,
  legend: DemandLegend,
): DemandLegendRow[] {
  const modeDef = demandModeDef(sel.mode);
  const belowSource = zoom < legend.minZoom;

  return activeDemandRoles(sel).map((role) => {
    const isJobs = role === 'jobs';
    const segment = DEMAND_SEGMENTS.find((s) => s.id === sel.segment);
    const label =
      role === 'jobs'
        ? 'Jobs'
        : role === 'backdrop'
          ? 'Everyone else'
          : role === 'composite'
            ? modeDef.restLabel
            : sel.segment === 'all'
              ? modeDef.allLabel
              : (segment?.label ?? sel.segment);
    return {
      role,
      label,
      color: roleColor(role),
      perDot: perDotAtZoom(role, zoom, legend),
      unit: isJobs ? legend.jobs.unit : legend.population.unit,
      // Only the composite radio is an estimate. A named flag is a straight ACS
      // count; so is the backdrop (population minus the estimate — so it inherits
      // the estimate's uncertainty, but it is not itself a modelled quantity).
      isEstimate: role === 'segment' && sel.segment === 'all',
      hiddenAtZoom: belowSource,
    };
  });
}

/**
 * The "you can't see what you just selected" warning, or null when everything on
 * screen actually draws.
 *
 * There is now only ONE way to get here — the map is below the source's own
 * minzoom, so no tiles are mounted at all. The old schema had a second way (a
 * segment CLASS that started deeper than the current tile zoom), and that is gone
 * with the classes: a person is in the tile or not, and their flags come with
 * them.
 *
 * Pure on purpose. The live-zoom plumbing that feeds it (MapView's `currentZoom`)
 * needs a real mapbox-gl instance and can't be unit-tested; it shipped BROKEN once
 * precisely because nothing exercised the pair (a `useEffect(…, [])` ran before
 * react-map-gl built the Map, so the ref was null and the listeners never attached
 * — currentZoom froze at the initial view). That half is now gated on `mapReady`;
 * this half is pinned by tests.
 */
export function demandZoomWarning(
  sel: DemandSelection,
  zoom: number,
  legend: DemandLegend,
): string | null {
  if (zoom >= legend.minZoom) return null;
  const names = demandLegendRows(sel, zoom, legend).map((r) => r.label).join(', ');
  if (!names) return null;
  return `Zoomed out too far to show ${names} — zoom in to level ${legend.minZoom}+ to see them.`;
}

/**
 * The reconciliation the control panel shows: how many DOTS of each role are on
 * screen, as a share of the population. Exported mainly so a test can assert the
 * thing that matters — segment + composite + backdrop covers every population
 * code, exactly once.
 */
export function populationRoleCodes(sel: DemandSelection): Record<DemandRole, number[]> {
  return codesByRole(sel);
}
