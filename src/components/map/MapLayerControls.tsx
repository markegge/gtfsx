import { useState } from 'react';
import {
  BACKDROP_COLOR,
  DEMAND_MODES,
  JOBS_COLOR,
  demandModeDef,
  isCompositeSelected,
  segmentsForMode,
  type DemandMode,
  type DemandSegment,
  type DemandSelection,
} from './demandCategories';
import {
  DEMAND_DATA_READY,
  DEMAND_LEGEND,
  DEMAND_UNAVAILABLE_REASON,
  demandLegendRows,
  demandZoomWarning,
  formatPerDot,
} from './demandLegend';

export type MapStyleId = 'light' | 'satellite';

/**
 * The legend when the layer can actually draw, null otherwise (tiles predate the
 * new classes, or we don't know which archive to fetch — see
 * DEMAND_UNAVAILABLE_REASON). One binding, so the control can't get out of step
 * with what the map does.
 */
const LEGEND = DEMAND_DATA_READY ? DEMAND_LEGEND : null;

interface MapLayerControlsProps {
  mapStyle: MapStyleId;
  onMapStyleChange: (style: MapStyleId) => void;
  showDemandDots: boolean;
  onShowDemandDotsChange: (show: boolean) => void;
  demandSelection: DemandSelection;
  onDemandModeChange: (mode: DemandMode) => void;
  onDemandSegmentChange: (segment: DemandSegment) => void;
  onDemandJobsChange: (show: boolean) => void;
  onDemandBackdropChange: (show: boolean) => void;
  /** Live map zoom — the legend's "1 dot ≈ N" is zoom-dependent. */
  currentZoom: number;
}

export function MapLayerControls({
  mapStyle,
  onMapStyleChange,
  showDemandDots,
  onShowDemandDotsChange,
  demandSelection,
  onDemandModeChange,
  onDemandSegmentChange,
  onDemandJobsChange,
  onDemandBackdropChange,
  currentZoom,
}: MapLayerControlsProps) {
  const [open, setOpen] = useState(false);
  // Demand dots (propensity map) are free for everyone, incl. anonymous — no gate.

  const modeDef = demandModeDef(demandSelection.mode);
  const segments = segmentsForMode(demandSelection.mode);
  // At most four rows. The three population roles — the segment you picked, the
  // REST of the mode's composite, and everyone else — are a PARTITION of the
  // resident population: every person is in exactly one of them, always. (Jobs
  // are a separate universe.) See roleForCode.
  const legendRows = LEGEND ? demandLegendRows(demandSelection, currentZoom, LEGEND) : [];
  // `currentZoom` only became a live value once MapView's listener attach was
  // fixed to wait for the map (mapReady) — before that this was dead code.
  const zoomWarning = LEGEND ? demandZoomWarning(demandSelection, currentZoom, LEGEND) : null;

  return (
    <div className="absolute top-3 left-3 z-10">
      <button
        onClick={() => setOpen(!open)}
        className={`w-9 h-9 rounded-lg flex items-center justify-center shadow-md transition-colors text-sm
          ${open ? 'bg-coral text-white' : 'bg-white text-brown hover:bg-cream'}`}
        title="Map layers"
      >
        ◫
      </button>

      {open && (
        <div className="mt-1.5 bg-white rounded-xl shadow-lg p-3 w-[272px] max-h-[calc(100vh-6rem)] overflow-y-auto">
          {/* Base map style */}
          <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
            Base Map
          </div>
          <div className="flex gap-1.5 mb-3">
            <button
              onClick={() => onMapStyleChange('light')}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors
                ${mapStyle === 'light' ? 'bg-coral-light text-coral' : 'bg-cream text-warm-gray hover:bg-sand'}`}
            >
              Streets
            </button>
            <button
              onClick={() => onMapStyleChange('satellite')}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors
                ${mapStyle === 'satellite' ? 'bg-coral-light text-coral' : 'bg-cream text-warm-gray hover:bg-sand'}`}
            >
              Satellite
            </button>
          </div>

          {/* Demand dots */}
          <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
            Transit Demand
          </div>
          <div className="flex items-center gap-1">
            <label
              className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors
                ${LEGEND ? 'cursor-pointer hover:bg-cream' : 'opacity-40 cursor-not-allowed'}`}
              title={DEMAND_UNAVAILABLE_REASON ?? 'Dot-density map of residents and jobs'}
            >
              <input
                type="checkbox"
                checked={showDemandDots && !!LEGEND}
                disabled={!LEGEND}
                onChange={(e) => onShowDemandDotsChange(e.target.checked)}
                className="accent-coral"
              />
              <span className="text-dark-brown">Demand Dots</span>
            </label>
            {/* Docs link — a sibling of the label rather than nested inside it,
                because the label wraps the checkbox: a nested <a> would risk
                also toggling the checkbox on click. Same "i" badge treatment as
                the NTD/External ID docs link in AgencyEditor. */}
            <a
              href="/docs/rider-propensity/"
              target="_blank"
              rel="noopener noreferrer"
              title="About the demand dot layer"
              aria-label="About the demand dot layer. Opens the docs in a new tab"
              className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full border border-warm-gray/50 text-[9px] font-bold text-warm-gray hover:border-coral hover:text-coral transition-colors"
            >
              i
            </a>
          </div>

          {/* The tiles predate the new categories: say so instead of offering a
              control that would draw an empty map. */}
          {DEMAND_UNAVAILABLE_REASON && (
            <p className="text-[9px] text-warm-gray/80 leading-snug px-2 mt-1">
              {DEMAND_UNAVAILABLE_REASON}
            </p>
          )}

          {showDemandDots && LEGEND && (
            <div className="mt-1.5">
              {/* Mode. The two modes ask different questions of the same people,
                  and each has its OWN composite + backdrop — which is what keeps
                  the segments below disjoint from the backdrop in both. */}
              <div className="flex gap-1.5 mb-2 px-0.5">
                {DEMAND_MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onDemandModeChange(m.id)}
                    title={m.hint}
                    className={`flex-1 px-1.5 py-1.5 rounded-md text-[10px] font-semibold leading-tight transition-colors
                      ${demandSelection.mode === m.id
                        ? 'bg-coral-light text-coral'
                        : 'bg-cream text-warm-gray hover:bg-sand'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {/* A radio, not checkboxes. Picking one HIGHLIGHTS it — the rest of
                  the composite stays on the map in a muted tone, and everyone else
                  stays gray, so the population is always fully drawn. Seniors and
                  Disability only appear in Transit need: they are not in the
                  propensity composite, and selecting one there would paint a
                  car-owning senior as a likely rider. */}
              <div className="flex flex-col gap-0.5">
                <label
                  title={modeDef.allHint}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] cursor-pointer hover:bg-cream transition-colors"
                >
                  <input
                    type="radio"
                    name="demand-segment"
                    checked={demandSelection.segment === 'all'}
                    onChange={() => onDemandSegmentChange('all')}
                    className="accent-coral w-3 h-3"
                  />
                  <span
                    className={`flex-1 ${demandSelection.segment === 'all' ? 'text-dark-brown font-semibold' : 'text-warm-gray'}`}
                  >
                    {modeDef.allLabel}
                  </span>
                  <span className="text-warm-gray/70 shrink-0">estimate</span>
                </label>

                {segments.map((seg) => {
                  const checked = demandSelection.segment === seg.id;
                  return (
                    <label
                      key={seg.id}
                      title={seg.hint}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] cursor-pointer hover:bg-cream transition-colors"
                    >
                      <input
                        type="radio"
                        name="demand-segment"
                        checked={checked}
                        onChange={() => onDemandSegmentChange(seg.id)}
                        className="accent-coral w-3 h-3"
                      />
                      <span
                        className={`flex-1 ${checked ? 'text-dark-brown font-semibold' : 'text-warm-gray'}`}
                      >
                        {seg.label}
                      </span>
                      <span className="text-warm-gray/70 shrink-0">ACS count</span>
                    </label>
                  );
                })}
              </div>

              {/* The two companions. "Everyone else" is the complement of the
                  mode's composite — the people in NEITHER the selected group nor
                  the rest of it — and jobs are a different universe (workplaces,
                  not residents), so both are plain checkboxes. */}
              <div className="flex flex-col gap-0.5 mt-1.5 pt-1.5 border-t border-cream">
                <label
                  title={modeDef.backdropHint}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] cursor-pointer hover:bg-cream transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={demandSelection.backdrop}
                    onChange={(e) => onDemandBackdropChange(e.target.checked)}
                    className="accent-coral w-3 h-3"
                  />
                  <span
                    className="w-2 h-2 rounded-full shrink-0 border"
                    style={{ background: BACKDROP_COLOR, borderColor: BACKDROP_COLOR }}
                  />
                  <span
                    className={`flex-1 ${demandSelection.backdrop ? 'text-dark-brown font-semibold' : 'text-warm-gray'}`}
                  >
                    Everyone else
                  </span>
                </label>
                <label
                  title="Jobs at the workplace location (LEHD LODES) — a different unit from the people dots"
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] cursor-pointer hover:bg-cream transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={demandSelection.jobs}
                    onChange={(e) => onDemandJobsChange(e.target.checked)}
                    className="accent-coral w-3 h-3"
                  />
                  <span
                    className="w-2 h-2 rounded-full shrink-0 border"
                    style={{ background: JOBS_COLOR, borderColor: JOBS_COLOR }}
                  />
                  <span
                    className={`flex-1 ${demandSelection.jobs ? 'text-dark-brown font-semibold' : 'text-warm-gray'}`}
                  >
                    Jobs
                  </span>
                </label>
              </div>

              {/* Legend. The "1 dot ≈ N" is the EFFECTIVE ratio at the current
                  zoom: the tiles carry only every Nth dot when zoomed out, so a
                  z8 dot stands for many more people than a z13 one. It updates as
                  the user zooms.

                  Below the source's minzoom NOTHING is mounted — the ratio would
                  describe dots that are not on screen, which is a number a
                  planner could put in a memo. `row.hiddenAtZoom` is exactly that
                  condition, so the ratio is dropped rather than shown false; the
                  zoom-warning paragraph below already says "zoom in to level N+"
                  once for the whole panel, so this doesn't repeat that text per
                  row. */}
              <div className="mt-1.5 pt-1.5 border-t border-cream flex flex-col gap-0.5">
                {legendRows.map((row) => (
                  <div
                    key={row.role}
                    className={`flex items-center gap-1.5 px-2 py-0.5 text-[10px] ${row.hiddenAtZoom ? 'opacity-40' : ''}`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0 border"
                      style={{ background: row.color, borderColor: row.color }}
                    />
                    <span className="flex-1 text-dark-brown truncate" title={row.label}>
                      {row.label}
                    </span>
                    {!row.hiddenAtZoom && (
                      <span className="text-warm-gray shrink-0 tabular-nums">
                        1 dot ≈ {formatPerDot(row.perDot)} {row.unit}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {zoomWarning && (
                <p className="text-[9px] text-coral font-semibold mt-1.5 px-2 leading-snug">
                  {zoomWarning}
                </p>
              )}

              {/* Honest framing where — and only where — it applies. The composite
                  is a PUMS-derived statistical union; the four segments are
                  straight ACS counts and are labelled as such. */}
              {isCompositeSelected(demandSelection) && (
                <p className="text-[9px] text-warm-gray/80 mt-1.5 px-2 leading-snug">
                  {modeDef.allLabel} is a statistical estimate, not a headcount: a
                  PUMS-derived union that de-duplicates people who fall into several
                  groups at once. Pick a single group below it for a straight ACS count.
                </p>
              )}

              <p className="text-[9px] text-warm-gray/70 mt-1.5 px-2 leading-snug">
                One dot = one person, drawn exactly once. Pick a group and the rest of
                the {modeDef.label.toLowerCase()} group stays on the map in a muted
                tone — “everyone else” means everyone else, not everyone else plus the
                people you didn’t pick. Based on ACS 2020–2024 5-yr + LEHD LODES 8
                (2023) + 2020 Census blocks (TIGER 2025). Nationwide coverage; AK and
                PR show population only (no LODES published).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
