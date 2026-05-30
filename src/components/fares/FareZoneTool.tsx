import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';

/**
 * Fare-zone assignment tool (issue #14). GTFS-Fares v1 zones are just a
 * `zone_id` string per stop — there's no zone geometry in the spec. This tool
 * lets the user draw a region on the map and stamp a chosen zone_id onto every
 * stop inside it (a one-shot lasso; the polygon isn't persisted). The drawing
 * itself happens in MapView's `draw_fare_zone` handler; this panel sets the
 * target zone via `window.__lassoFareZoneId` and reports the result back via
 * `window.__onFareZoneAssigned`.
 */
export function FareZoneTool() {
  const stops = useStore((s) => s.stops);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);

  const [zoneId, setZoneId] = useState('');
  const [result, setResult] = useState<{ count: number; zoneId: string } | null>(null);

  const isDrawing = mapMode === 'draw_fare_zone';

  // Zones present in the feed today, derived from stop.zone_id, with counts.
  const zones = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stops) {
      if (s.zone_id) counts.set(s.zone_id, (counts.get(s.zone_id) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [stops]);
  const stopsWithoutZone = useMemo(() => stops.filter((s) => !s.zone_id).length, [stops]);

  // Let MapView report how many stops the lasso assigned.
  useEffect(() => {
    window.__onFareZoneAssigned = (count, zid) => setResult({ count, zoneId: zid });
    return () => { window.__onFareZoneAssigned = undefined; };
  }, []);

  const startDraw = () => {
    const z = zoneId.trim();
    if (!z) return;
    window.__lassoFareZoneId = z;
    setResult(null);
    setMapMode('draw_fare_zone');
  };

  return (
    <div>
      <p className="text-sm text-warm-gray mb-3">
        A fare zone is just a <code className="text-[12px] bg-cream px-1 rounded">zone_id</code> on
        each stop. Draw a region on the map to assign a zone to every stop inside it, then price
        zone-to-zone trips in the Fares tab.
      </p>

      <div className="mb-4 p-3 rounded-lg bg-cream border border-sand">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Zone to assign
        </label>
        <input
          list="fare-zone-ids"
          value={zoneId}
          onChange={(e) => setZoneId(e.target.value)}
          placeholder="e.g. downtown, zone-1"
          disabled={isDrawing}
          className="w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-white font-mono disabled:opacity-60"
        />
        <datalist id="fare-zone-ids">
          {zones.map(([z]) => <option key={z} value={z} />)}
        </datalist>

        {isDrawing ? (
          <div className="mt-2">
            <div className="p-2 rounded-md bg-gold-light text-amber-800 text-[11px] mb-2">
              Drawing zone <strong>{(window.__lassoFareZoneId || zoneId).trim()}</strong> — click the
              map to add vertices, double-click to finish. Every stop inside the shape gets this zone.
            </div>
            <button
              onClick={() => setMapMode('select')}
              className="w-full px-3 py-2 rounded-lg text-sm font-semibold bg-sand text-brown hover:bg-red-100 hover:text-red-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={startDraw}
            disabled={!zoneId.trim() || stops.length === 0}
            className="mt-2 w-full px-3 py-2 rounded-lg text-sm font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-40"
          >
            Draw on map to assign
          </button>
        )}

        {result && !isDrawing && (
          <p className="mt-2 text-[12px] text-teal font-semibold">
            Assigned {result.count} stop{result.count === 1 ? '' : 's'} to “{result.zoneId}”.
          </p>
        )}
        {stops.length === 0 && (
          <p className="mt-2 text-[11px] text-warm-gray">Add stops before assigning zones.</p>
        )}
      </div>

      <h3 className="font-heading font-bold text-sm text-dark-brown mb-2">Zones in this feed</h3>
      {zones.length === 0 ? (
        <p className="text-xs text-warm-gray">
          No fare zones yet. Draw one above, or set a stop's Fare Zone ID in the stop editor.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {zones.map(([z, count]) => (
            <li key={z} className="flex items-center justify-between px-3 py-1.5 rounded-md bg-cream text-sm">
              <span className="font-mono text-dark-brown truncate">{z}</span>
              <span className="text-[11px] text-warm-gray shrink-0">{count} stop{count === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ul>
      )}
      {zones.length > 0 && stopsWithoutZone > 0 && (
        <p className="mt-2 text-[11px] text-warm-gray">
          {stopsWithoutZone} stop{stopsWithoutZone === 1 ? '' : 's'} not in any zone.
        </p>
      )}
    </div>
  );
}
