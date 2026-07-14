import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import type { LayerProps } from 'react-map-gl/mapbox';
import type { DataDrivenPropertyValueSpecification } from 'mapbox-gl';
import {
  DEMAND_CIRCLE_OPACITY,
  buildDemandColor,
  buildDemandFilter,
  type DemandSelection,
} from './demandCategories';
import { DEMAND_DATA_READY, DEMAND_LEGEND, DEMAND_TILE_ARCHIVE } from './demandLegend';

// Hoisted so the `tiles` prop is referentially stable across renders.
// react-map-gl's <Source> diffs its props with deepEqual and calls
// source.setTiles() on any change, which would drop the tile cache — a visible
// reload. A stable array (plus a stable id/type) guarantees that changing the
// selection only ever touches the LAYER (map.setFilter), never the source.
//
// The archive is resolved in demandLegend.ts (pipeline legend → env override →
// unavailable). It is never guessed: a wrong name 404s every tile.
const TILES = [`${window.location.origin}/_demand-tiles/${DEMAND_TILE_ARCHIVE}/{z}/{x}/{y}.pbf`];

// Zoom envelope + source-layer of the archive, straight from the legend — the
// tileset is z8–15 today. The fallbacks only exist so this module can be imported
// on the not-ready path, where the layer never mounts.
//
// SOURCE_MAXZOOM must be the DEEPEST ZOOM THE ARCHIVE ACTUALLY HAS, not the
// deepest zoom a user can reach. Mapbox stops requesting deeper tiles at maxzoom
// and OVERZOOMS the ones it has, which is what keeps the dots on screen at z16,
// z17, z18. Declare one deeper than exists and it does the opposite: it asks for
// a z16 tile, gets a 404, and renders nothing — the layer went blank from z16 in
// for exactly this reason (legend said 16, tippecanoe built 15), at precisely the
// zoom a planner does stop-level work at. The pipeline now generates both numbers
// from one constant (build_dots.TILE_MAX_ZOOM) and verify_tiles.py asserts the
// built archive agrees, so they cannot drift apart again.
const SOURCE_MINZOOM = DEMAND_LEGEND?.minZoom ?? 8;
const SOURCE_MAXZOOM = DEMAND_LEGEND?.maxZoom ?? 15;
const SOURCE_LAYER = DEMAND_LEGEND?.sourceLayer ?? 'demand';

interface Props {
  visible: boolean;
  /** Mode + segment + companions. Applied as a client-side filter expression. */
  selection: DemandSelection;
}

// Dot SIZE never varies by class — only what one dot COUNTS FOR does, and that
// is a legend concern (per-class per_dot × the zoom sampling ladder; see
// perDotAtZoom in demandLegend.ts). Don't put a fixed "1 dot = 5" ratio in this
// file: it is neither constant across classes nor across zooms.
//
// The z8 rung used to be 0.5px (with opacity 0.4 in demandCategories), which was
// a workaround for a bug rather than a cartographic choice: tippecanoe was
// dropping 98% of the z8 dots, and shrinking what survived was the only way to
// stop the few remaining ones from reading as noise. The z8 tiles now carry
// exactly what the ladder says they carry, so the dots are a real, honest sample
// and are drawn as such — a sub-pixel dot at 40% opacity would hide the very
// density the layer exists to show.
const CIRCLE_RADIUS: DataDrivenPropertyValueSpecification<number> = [
  'interpolate', ['linear'], ['zoom'],
  8, 1.1,
  10, 1.2,
  12, 1.4,
  13, 1.6,
  15, 2,
];

export function DemandDotsLayer({ visible, selection }: Props) {
  // BOTH the filter and the color depend on the selection now, and that is the
  // whole idea: a dot is a person carrying membership flags, so the SAME dot is
  // the strong blue when you select Carless and a muted tone when you select Low
  // income. The tiles never change — Mapbox applies a selection change with one
  // setFilter + one setPaintProperty against already-loaded tiles, so switching
  // mode or segment refetches nothing.
  //
  // (Under the old schema the color was a static class→color map and only the
  // filter moved. That is exactly what forced the composites and backdrops to be
  // baked in as CLASSES — and it is why selecting a segment drew the backdrop of
  // the whole composite, leaving the rest of the composite drawn nowhere.)
  const layerStyle = useMemo<LayerProps>(
    () => ({
      id: 'demand-dots',
      type: 'circle',
      source: 'demand-dots',
      'source-layer': SOURCE_LAYER,
      filter: buildDemandFilter(selection),
      paint: {
        'circle-radius': CIRCLE_RADIUS,
        'circle-color': buildDemandColor(selection),
        'circle-opacity': DEMAND_CIRCLE_OPACITY,
        'circle-stroke-width': 0,
      },
    }),
    [selection],
  );

  // Not ready → either the deployed tiles predate the new class vocabulary (every
  // filter we could build would match nothing) or we don't know which archive to
  // fetch. Mounting the source anyway would paint an empty overlay with no
  // explanation; instead we don't mount, and MapLayerControls says why
  // (DEMAND_UNAVAILABLE_REASON).
  if (!visible || !DEMAND_DATA_READY) return null;
  return (
    <Source
      id="demand-dots"
      type="vector"
      tiles={TILES}
      minzoom={SOURCE_MINZOOM}
      maxzoom={SOURCE_MAXZOOM}
    >
      <Layer {...layerStyle} beforeId="stop-circles-outer" />
    </Source>
  );
}
