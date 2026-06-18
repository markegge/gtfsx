// C7 — generate (B1) → block (B3) → export → re-import: block_id + times intact.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { generateTrips } from '../timetableGen';
import { buildBlocks } from '../blockBuilder';
import { exportGtfsZip } from '../gtfsExport';
import { importGtfsZip } from '../gtfsParse';
import type { RouteStop } from '../../types/gtfs';

const PATTERN: RouteStop[] = [
  { route_id: 'R1', stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false },
  { route_id: 'R1', stop_id: 's2', direction_id: 0, stop_sequence: 2, _snapped: false },
];

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setRoutes([{ route_id: 'R1', agency_id: 'A', route_short_name: 'R1', route_long_name: 'Route 1', route_type: 3 } as never]);
  s.setRouteStops(PATTERN as never);
  s.setStops([
    { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never,
    { stop_id: 's2', stop_name: 'B', stop_lat: 45.02, stop_lon: -111, wheelchair_boarding: 0 } as never,
  ]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setFrequencies([]);
});

describe('C7 schedule → feed round-trip', () => {
  it('a generated + blocked feed exports and re-imports with block_id and times intact', async () => {
    const s = useStore.getState();

    // B1 — generate 06:00–08:00 @30m, 20-min run.
    const gen = generateTrips({
      routeId: 'R1', directionId: 0, serviceId: 'wk',
      startTime: '06:00', endTime: '08:00', headwaySecs: 1800, runSecs: 1200,
      mode: 'explicit', routeStops: PATTERN, headsign: 'B',
    });
    expect(gen.trips).toHaveLength(5);
    s.setTrips(gen.trips as never);
    s.setStopTimes(gen.stopTimes as never);

    // B3 — Quick Block.
    const blocks = buildBlocks(gen.trips, gen.stopTimes, useStore.getState().stops, { serviceId: 'wk', interline: false });
    for (const t of gen.trips) {
      const b = blocks.get(t.trip_id);
      if (b) s.updateTrip(t.trip_id, { block_id: b });
    }
    // The 30-min headway / 20-min run trips chain onto one vehicle.
    expect(new Set(blocks.values()).size).toBe(1);

    // Export → re-import. JSZip (inside importGtfsZip) reads a Uint8Array in any
    // environment (node Blob support is patchy), so feed it the bytes directly.
    const blob = await exportGtfsZip();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const reimported = await importGtfsZip(bytes as unknown as File);

    expect(reimported.trips).toHaveLength(5);
    // Every trip kept its block_id.
    for (const t of reimported.trips) expect(t.block_id).toBe('B1');

    // A known trip's stop_times survived (06:00 → 06:20).
    const t0 = gen.trips[0].trip_id;
    const t0Times = reimported.stopTimes.filter((st) => st.trip_id === t0).sort((a, b) => a.stop_sequence - b.stop_sequence);
    expect(t0Times[0].departure_time).toBe('06:00:00');
    expect(t0Times[t0Times.length - 1].arrival_time).toBe('06:20:00');
  });
});
