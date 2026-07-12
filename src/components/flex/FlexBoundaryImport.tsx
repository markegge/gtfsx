import { useRef, useState } from 'react';
import { useStore } from '../../store';
import { createFlexZoneWithRoute, nextFlexZoneName, parseBoundaryGeoJson } from './flexHelpers';

/**
 * Fourth zone-creation path: an agency's existing service-area boundary,
 * uploaded as GeoJSON, instead of being redrawn by hand. Parsing/validation
 * lives in parseBoundaryGeoJson (pure, unit-tested); this component owns the
 * file handoff, the inline error, and the post-import "land where you'd land
 * after drawing" behavior (fit the map, open Details).
 */

type Bounds = [[number, number], [number, number]];

function geojsonBounds(fc: GeoJSON.FeatureCollection): Bounds | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const visit = ([lng, lat]: GeoJSON.Position) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') {
      for (const ring of g.coordinates) ring.forEach(visit);
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) for (const ring of poly) ring.forEach(visit);
    }
  }
  if (minLng === Infinity) return null;
  return [[minLng, minLat], [maxLng, maxLat]];
}

interface FlexBoundaryImportProps {
  /** Called with the new zone's id once the boundary imported cleanly. */
  onImported: (zoneId: string) => void;
}

export function FlexBoundaryImport({ onImported }: FlexBoundaryImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("Couldn't read that file.");
      return;
    }

    const result = parseBoundaryGeoJson(text, file.name);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    const zoneId = `flex-zone-${Date.now()}`;
    // Same construction as a drawn zone — the paired 715 route, the auto-picked
    // lone service_id, and the naming all come from createFlexZoneWithRoute.
    createFlexZoneWithRoute({
      id: zoneId,
      name: result.name || nextFlexZoneName(useStore.getState().flexZones),
      bufferMiles: 0,
      geojson: result.geojson,
    });

    const bounds = geojsonBounds(result.geojson);
    if (bounds) window.__mapFitBounds?.(bounds, { padding: 80, maxZoom: 14 });
    onImported(zoneId);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) void handleFile(file);
      }}
      className={`bg-white border rounded-lg p-3 space-y-2 transition-colors
        ${dragOver ? 'border-purple bg-purple-50' : 'border-sand'}`}
    >
      <p className="text-xs font-semibold text-dark-brown">Import boundary (GeoJSON)</p>
      <p className="text-[11px] text-warm-gray">
        Upload your service area's official boundary. Polygon or MultiPolygon only —
        the GTFS <code className="px-1 bg-sand rounded">locations.geojson</code> spec
        allows no other geometry.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so re-picking the same file after an error fires onChange again.
          e.target.value = '';
          if (file) void handleFile(file);
        }}
      />
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <button
        onClick={() => inputRef.current?.click()}
        className="w-full px-3 py-2 bg-white border border-purple text-purple rounded-lg text-xs font-heading font-bold hover:bg-purple-50 transition-colors flex items-center justify-center gap-2"
      >
        <span>⬆</span> Choose GeoJSON File
      </button>
      <p className="text-[11px] text-warm-gray">Or drop the file here.</p>
    </div>
  );
}
