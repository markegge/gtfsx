// Pure GTFS parsing — no Zustand store, no browser-only globals — so it can
// run inside a Web Worker (see gtfsImport.worker.ts). Store-mutating helpers
// (loadImportIntoStore / mergeImportIntoStore) live in gtfsImport.ts, which
// re-exports everything here for existing import sites.
import JSZip from 'jszip';
import Papa from 'papaparse';
import length from '@turf/length';
import { lineString } from '@turf/helpers';
import type {
  Agency, Calendar, CalendarDate, Route, Shape, ShapePoint, Stop, Trip, StopTime, FeedInfo, RouteStop,
  FareAttribute, FareRule, Transfer, Frequency, Pathway, Level,
  FareArea, StopArea, FareNetwork, RouteNetwork, Timeframe, RiderCategory, FareMedia,
  FareProduct, FareLegRule, FareTransferRule,
} from '../types/gtfs';
import type { FlexZone, BookingRule } from '../store/flexSlice';

/** Populate shape_dist_traveled (cumulative metres) from the lat/lon geometry.
 *  Mirrors shapeSlice.recalcShapeDistances so the import path doesn't need the
 *  store mutator — we're still building the Shape array here.
 *
 *  Accumulates per-segment distances in a single pass: O(n). (The previous
 *  version rebuilt and re-measured the whole polyline at every point — O(n²) —
 *  which made dense regional feeds like RTD Denver take minutes to import.)
 *  Result is identical: turf `length` sums consecutive-point haversine
 *  distances, so summing each segment equals measuring the line up to point i. */
function fillShapeDistances(points: ShapePoint[]): ShapePoint[] {
  if (points.length < 2) return points;
  points[0].shape_dist_traveled = 0;
  let cumulative = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const segment = lineString([
      [prev.shape_pt_lon, prev.shape_pt_lat],
      [cur.shape_pt_lon, cur.shape_pt_lat],
    ]);
    cumulative += length(segment, { units: 'meters' });
    cur.shape_dist_traveled = cumulative;
  }
  return points;
}

type CsvRow = Record<string, string>;

function parseCSV<T = CsvRow>(text: string): T[] {
  const result = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
  return result.data as T[];
}

function num(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function describeService(...days: number[]): string {
  const [m, t, w, th, f, sa, su] = days;
  if (m && t && w && th && f && !sa && !su) return 'Weekdays';
  if (!m && !t && !w && !th && !f && sa && su) return 'Weekends';
  if (m && t && w && th && f && sa && su) return 'Daily';
  if (!m && !t && !w && !th && !f && sa && !su) return 'Saturday Only';
  if (!m && !t && !w && !th && !f && !sa && su) return 'Sunday Only';
  return 'Custom';
}

/** Combined uncompressed size of the heavy tables (stop_times + shapes) above
 * which the in-browser editor is likely to be slow or crash the tab. The whole
 * feed is held in memory (Zustand store) and rendered un-virtualized, and
 * stop_times + shapes are by far the largest tables. A typical single-agency
 * feed stays well under this; RTD-Denver-class regional feeds (≈35 MB
 * stop_times + ≈26 MB shapes) blow past it. Tuned so RTD trips it with margin
 * while ordinary feeds don't. */
export const LARGE_FEED_BYTES = 25 * 1024 * 1024; // ~25 MB of stop_times + shapes

/** Cheap pre-flight: read the *uncompressed* sizes of stop_times.txt and
 * shapes.txt straight from the ZIP's central directory WITHOUT decompressing
 * or parsing them, so the UI can warn before the expensive parse + in-memory
 * load that hangs/crashes the tab. Falls back to a scaled compressed-archive
 * estimate if the per-entry metadata isn't available. */
export async function inspectGtfsZip(file: File): Promise<{
  stopTimesBytes: number;
  shapesBytes: number;
  estimatedRows: number;
  isLarge: boolean;
}> {
  const zip = await JSZip.loadAsync(file);
  // JSZip records each entry's uncompressed size on the internal `_data`
  // record; it isn't part of the public type, hence the cast.
  const uncompressedSize = (name: string, re: RegExp): number => {
    const entry = zip.file(name) ?? zip.file(re)[0] ?? null;
    const meta = entry as unknown as { _data?: { uncompressedSize?: number } } | null;
    return meta?._data?.uncompressedSize ?? 0;
  };
  const stopTimesBytes = uncompressedSize('stop_times.txt', /stop_times\.txt$/);
  const shapesBytes = uncompressedSize('shapes.txt', /shapes\.txt$/);
  // If stop_times metadata is somehow missing, fall back to ~4× the compressed
  // archive size as a rough proxy for the heavy-table footprint.
  const heavyBytes = stopTimesBytes > 0 ? stopTimesBytes + shapesBytes : Math.round(file.size * 4);
  // GTFS stop_times rows average roughly 55 bytes uncompressed; good enough
  // to put an order-of-magnitude row count in front of the user.
  const estimatedRows = Math.round(stopTimesBytes / 55);
  return {
    stopTimesBytes,
    shapesBytes,
    estimatedRows,
    isLarge: heavyBytes > LARGE_FEED_BYTES,
  };
}

/** Coarse progress callback for the import. Phases are reported as they start
 * so the UI can show motion through a large feed instead of a frozen spinner.
 * `rows` is set during stop_times parsing — the long pole on big feeds. */
export type ImportProgress = (p: { phase: string; rows?: number }) => void;

export async function importGtfsZip(file: File, onProgress?: ImportProgress): Promise<{
  agencies: Agency[];
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  routes: Route[];
  shapes: Shape[];
  stops: Stop[];
  trips: Trip[];
  stopTimes: StopTime[];
  feedInfo: FeedInfo | null;
  routeStops: RouteStop[];
  fareAttributes: FareAttribute[];
  fareRules: FareRule[];
  transfers: Transfer[];
  frequencies: Frequency[];
  levels: Level[];
  pathways: Pathway[];
  fareAreas: FareArea[];
  stopAreas: StopArea[];
  fareNetworks: FareNetwork[];
  routeNetworks: RouteNetwork[];
  timeframes: Timeframe[];
  riderCategories: RiderCategory[];
  fareMedia: FareMedia[];
  fareProducts: FareProduct[];
  fareLegRules: FareLegRule[];
  fareTransferRules: FareTransferRule[];
  flexZones: FlexZone[];
  warnings: string[];
}> {
  const report: ImportProgress = onProgress ?? (() => {});
  report({ phase: 'Reading archive…' });
  const zip = await JSZip.loadAsync(file);

  // Detect if files are nested inside a subfolder
  const warnings: string[] = [];
  const hasRootAgency = !!zip.file('agency.txt');
  const hasRootRoutes = !!zip.file('routes.txt');
  if (!hasRootAgency && !hasRootRoutes) {
    const nestedAgency = zip.file(/agency\.txt$/);
    const nestedRoutes = zip.file(/routes\.txt$/);
    if (nestedAgency.length > 0 || nestedRoutes.length > 0) {
      const path = (nestedAgency[0] || nestedRoutes[0]).name;
      const folder = path.split('/').slice(0, -1).join('/');
      warnings.push(`Feed files are inside a subfolder "${folder}/" in the ZIP. GTFS files should be at the root of the archive. This has been handled automatically and will be corrected on export.`);
    }
  }

  const readFile = async (name: string): Promise<string | null> => {
    // Try both with and without folder prefix
    let entry = zip.file(name);
    if (!entry) {
      // Look in subdirectories
      const entries = zip.file(new RegExp(`${name}$`));
      entry = entries[0] || null;
    }
    if (!entry) return null;
    return await entry.async('string');
  };

  // Agency. `external_id` is a custom column (the agency's NTD ID, in the US) —
  // read per-row so each agency keeps its OWN value across a round-trip. It is a
  // STRING with significant leading zeros ("01234"): parseCSV runs with
  // dynamicTyping:false, so the value arrives as a string and must stay one —
  // never Number()-coerce it. Blank cells normalize to undefined so a feed whose
  // column is entirely empty doesn't re-export an empty column.
  const agencyText = await readFile('agency.txt');
  const agencies: Agency[] = agencyText
    ? parseCSV(agencyText).map((row) => ({
        agency_id: row.agency_id || '',
        agency_name: row.agency_name || '',
        agency_url: row.agency_url || '',
        agency_timezone: row.agency_timezone || 'America/New_York',
        agency_lang: row.agency_lang,
        agency_phone: row.agency_phone,
        agency_fare_url: row.agency_fare_url,
        agency_email: row.agency_email,
        external_id: String(row.external_id ?? '').trim() || undefined,
      }))
    : [];

  // Calendar
  const calendarText = await readFile('calendar.txt');
  const calendars: Calendar[] = calendarText
    ? parseCSV(calendarText).map((row) => ({
        service_id: String(row.service_id),
        monday: (num(row.monday) as 0 | 1),
        tuesday: (num(row.tuesday) as 0 | 1),
        wednesday: (num(row.wednesday) as 0 | 1),
        thursday: (num(row.thursday) as 0 | 1),
        friday: (num(row.friday) as 0 | 1),
        saturday: (num(row.saturday) as 0 | 1),
        sunday: (num(row.sunday) as 0 | 1),
        start_date: String(row.start_date),
        end_date: String(row.end_date),
        _description: describeService(num(row.monday), num(row.tuesday), num(row.wednesday), num(row.thursday), num(row.friday), num(row.saturday), num(row.sunday)),
      }))
    : [];

  // Calendar dates
  const calDatesText = await readFile('calendar_dates.txt');
  const calendarDates: CalendarDate[] = calDatesText
    ? parseCSV(calDatesText).map((row) => ({
        service_id: String(row.service_id),
        date: String(row.date),
        exception_type: num(row.exception_type) as 1 | 2,
      }))
    : [];

  // Routes
  const routesText = await readFile('routes.txt');
  const routes: Route[] = routesText
    ? parseCSV(routesText).map((row) => ({
        route_id: String(row.route_id),
        agency_id: String(row.agency_id || agencies[0]?.agency_id || ''),
        route_short_name: row.route_short_name || '',
        route_long_name: row.route_long_name || '',
        route_desc: row.route_desc,
        route_type: num(row.route_type),
        route_url: row.route_url,
        route_color: (row.route_color || '888888').replace('#', ''),
        route_text_color: (row.route_text_color || 'FFFFFF').replace('#', ''),
        continuous_pickup: row.continuous_pickup !== undefined && row.continuous_pickup !== ''
          ? (num(row.continuous_pickup) as 0 | 1 | 2 | 3) : undefined,
        continuous_drop_off: row.continuous_drop_off !== undefined && row.continuous_drop_off !== ''
          ? (num(row.continuous_drop_off) as 0 | 1 | 2 | 3) : undefined,
      }))
    : [];

  // Shapes
  const shapesText = await readFile('shapes.txt');
  const shapesMap = new Map<string, ShapePoint[]>();
  if (shapesText) {
    const rows = parseCSV(shapesText);
    for (const row of rows) {
      const id = String(row.shape_id);
      if (!shapesMap.has(id)) shapesMap.set(id, []);
      shapesMap.get(id)!.push({
        shape_pt_lat: num(row.shape_pt_lat),
        shape_pt_lon: num(row.shape_pt_lon),
        shape_pt_sequence: num(row.shape_pt_sequence),
        shape_dist_traveled: num(row.shape_dist_traveled),
      });
    }
  }
  // If the source feed omitted shape_dist_traveled (or provided all zeros),
  // compute it from the geometry on import. Otherwise an export of the same
  // feed emits 2013x `equal_shape_distance_diff_coordinates` validator errors
  // because consecutive points share a zero cumulative distance.
  const shapes: Shape[] = Array.from(shapesMap.entries()).map(([id, rawPoints]) => {
    const points = rawPoints.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    const hasRealDistances = points.some((p) => p.shape_dist_traveled !== 0);
    return {
      shape_id: id,
      points: hasRealDistances ? points : fillShapeDistances(points),
    };
  });

  // Stops
  report({ phase: 'Parsing stops…' });
  const stopsText = await readFile('stops.txt');
  const stops: Stop[] = stopsText
    ? parseCSV(stopsText).map((row) => ({
        stop_id: String(row.stop_id),
        stop_code: row.stop_code || undefined,
        stop_name: row.stop_name || '',
        stop_desc: row.stop_desc || undefined,
        stop_lat: num(row.stop_lat),
        stop_lon: num(row.stop_lon),
        zone_id: row.zone_id || undefined,
        stop_url: row.stop_url || undefined,
        location_type: num(row.location_type),
        parent_station: row.parent_station || undefined,
        stop_timezone: row.stop_timezone || undefined,
        wheelchair_boarding: num(row.wheelchair_boarding),
        level_id: row.level_id || undefined,
      }))
    : [];

  // Trips
  report({ phase: 'Parsing trips…' });
  const tripsText = await readFile('trips.txt');
  const tripRows = tripsText ? parseCSV(tripsText) : [];
  const trips: Trip[] = tripRows.map((row) => ({
    trip_id: String(row.trip_id),
    route_id: String(row.route_id),
    service_id: String(row.service_id),
    trip_headsign: row.trip_headsign || undefined,
    trip_short_name: row.trip_short_name || undefined,
    direction_id: (num(row.direction_id) as 0 | 1),
    block_id: row.block_id ? String(row.block_id) : undefined,
    shape_id: row.shape_id ? String(row.shape_id) : undefined,
    wheelchair_accessible: row.wheelchair_accessible !== undefined ? num(row.wheelchair_accessible) : undefined,
  }));

  // GTFS-Flex puts safe_duration_factor / safe_duration_offset on trips.txt.
  // Keep only the trips that carry them; the flex zones read them back below.
  const tripSafeDuration = new Map<string, { factor?: number; offset?: number }>();
  for (const row of tripRows) {
    const hasFactor = row.safe_duration_factor !== undefined && row.safe_duration_factor !== '';
    const hasOffset = row.safe_duration_offset !== undefined && row.safe_duration_offset !== '';
    if (!hasFactor && !hasOffset) continue;
    tripSafeDuration.set(String(row.trip_id), {
      factor: hasFactor ? num(row.safe_duration_factor) : undefined,
      offset: hasOffset ? num(row.safe_duration_offset) : undefined,
    });
  }

  // Stop times. A flex stop_time has a location_id (polygon) or
  // location_group_id (stop group) instead of stop_id; we split those out
  // so they can feed back into FlexZone metadata (and don't pollute the
  // fixed-route stop_times table).
  report({ phase: 'Parsing stop times…' });
  const stopTimesText = await readFile('stop_times.txt');
  const stopTimesAll = stopTimesText ? parseCSV(stopTimesText) : [];
  const flexStopTimeRows: CsvRow[] = [];
  const stopTimes: StopTime[] = [];
  for (let i = 0; i < stopTimesAll.length; i++) {
    const row = stopTimesAll[i];
    // Report every 250k rows so the UI advances on a multi-million-row feed.
    if (i > 0 && i % 250_000 === 0) report({ phase: 'Parsing stop times…', rows: i });
    const isFlex = (row.location_id && !row.stop_id) ||
                   (row.location_group_id && !row.stop_id);
    if (isFlex) {
      flexStopTimeRows.push(row);
      continue;
    }
    stopTimes.push({
      trip_id: String(row.trip_id),
      arrival_time: row.arrival_time || '',
      departure_time: row.departure_time || '',
      stop_id: String(row.stop_id),
      stop_sequence: num(row.stop_sequence),
      stop_headsign: row.stop_headsign || undefined,
      pickup_type: row.pickup_type !== undefined ? num(row.pickup_type) : undefined,
      drop_off_type: row.drop_off_type !== undefined ? num(row.drop_off_type) : undefined,
      shape_dist_traveled: row.shape_dist_traveled ? num(row.shape_dist_traveled) : undefined,
      timepoint: row.timepoint !== undefined ? (num(row.timepoint) as 0 | 1) : undefined,
      continuous_pickup: row.continuous_pickup !== undefined && row.continuous_pickup !== ''
        ? (num(row.continuous_pickup) as 0 | 1 | 2 | 3) : undefined,
      continuous_drop_off: row.continuous_drop_off !== undefined && row.continuous_drop_off !== ''
        ? (num(row.continuous_drop_off) as 0 | 1 | 2 | 3) : undefined,
    });
  }
  const flexTripIds = new Set<string>(flexStopTimeRows.map((r) => String(r.trip_id)));

  // Feed info
  const feedInfoText = await readFile('feed_info.txt');
  let feedInfo: FeedInfo | null = null;
  if (feedInfoText) {
    const rows = parseCSV(feedInfoText);
    if (rows[0]) {
      const r = rows[0];
      feedInfo = {
        feed_publisher_name: r.feed_publisher_name || '',
        feed_publisher_url: r.feed_publisher_url || '',
        feed_lang: r.feed_lang || 'en-US',
        default_lang: r.default_lang,
        feed_start_date: r.feed_start_date,
        feed_end_date: r.feed_end_date,
        feed_version: r.feed_version,
        feed_contact_email: r.feed_contact_email,
        feed_contact_url: r.feed_contact_url,
      };
    }
  }

  // Fare attributes
  const fareAttrText = await readFile('fare_attributes.txt');
  const fareAttributes: FareAttribute[] = fareAttrText
    ? parseCSV(fareAttrText).map((row) => ({
        fare_id: String(row.fare_id),
        price: String(row.price),
        currency_type: String(row.currency_type || 'USD'),
        payment_method: num(row.payment_method) as 0 | 1,
        transfers: row.transfers === '' || row.transfers === undefined ? '' : (num(row.transfers) as 0 | 1 | 2),
        transfer_duration: row.transfer_duration ? num(row.transfer_duration) : undefined,
        agency_id: row.agency_id || undefined,
      }))
    : [];

  // Fare rules
  const fareRulesText = await readFile('fare_rules.txt');
  const fareRules: FareRule[] = fareRulesText
    ? parseCSV(fareRulesText).map((row) => ({
        fare_id: String(row.fare_id),
        route_id: row.route_id || undefined,
        origin_id: row.origin_id || undefined,
        destination_id: row.destination_id || undefined,
        contains_id: row.contains_id || undefined,
      }))
    : [];

  // Transfers
  const transfersText = await readFile('transfers.txt');
  const transfers: Transfer[] = transfersText
    ? parseCSV(transfersText)
        .filter((row) => row.from_stop_id && row.to_stop_id)
        .map((row) => ({
          from_stop_id: String(row.from_stop_id),
          to_stop_id: String(row.to_stop_id),
          transfer_type: (num(row.transfer_type) as 0 | 1 | 2 | 3),
          min_transfer_time: row.min_transfer_time !== undefined && row.min_transfer_time !== ''
            ? num(row.min_transfer_time) : undefined,
        }))
    : [];

  // Frequencies — headway-based service per trip. Times may exceed 24:00:00.
  const frequenciesText = await readFile('frequencies.txt');
  const frequencies: Frequency[] = frequenciesText
    ? parseCSV(frequenciesText)
        .filter((row) => row.trip_id && row.start_time && row.end_time)
        .map((row) => ({
          trip_id: String(row.trip_id),
          start_time: String(row.start_time),
          end_time: String(row.end_time),
          headway_secs: num(row.headway_secs),
          exact_times: row.exact_times !== undefined && row.exact_times !== ''
            ? (num(row.exact_times) as 0 | 1) : undefined,
        }))
    : [];

  // Levels — station floors referenced by stops.level_id and pathways.
  const levelsText = await readFile('levels.txt');
  const levels: Level[] = levelsText
    ? parseCSV(levelsText)
        .filter((row) => row.level_id)
        .map((row) => ({
          level_id: String(row.level_id),
          level_index: num(row.level_index),
          level_name: row.level_name || undefined,
        }))
    : [];

  // Pathways — directed in-station connections. Every optional column is typed
  // so an imported feed round-trips without dropping data.
  const pathwaysText = await readFile('pathways.txt');
  const pathways: Pathway[] = pathwaysText
    ? parseCSV(pathwaysText)
        .filter((row) => row.pathway_id && row.from_stop_id && row.to_stop_id)
        .map((row) => ({
          pathway_id: String(row.pathway_id),
          from_stop_id: String(row.from_stop_id),
          to_stop_id: String(row.to_stop_id),
          pathway_mode: (num(row.pathway_mode) as Pathway['pathway_mode']),
          is_bidirectional: (num(row.is_bidirectional) as 0 | 1),
          length: row.length !== undefined && row.length !== '' ? num(row.length) : undefined,
          traversal_time: row.traversal_time !== undefined && row.traversal_time !== '' ? num(row.traversal_time) : undefined,
          stair_count: row.stair_count !== undefined && row.stair_count !== '' ? num(row.stair_count) : undefined,
          max_slope: row.max_slope !== undefined && row.max_slope !== '' ? num(row.max_slope) : undefined,
          min_width: row.min_width !== undefined && row.min_width !== '' ? num(row.min_width) : undefined,
          signposted_as: row.signposted_as || undefined,
          reversed_signposted_as: row.reversed_signposted_as || undefined,
        }))
    : [];

  // GTFS-Fares v2 (round-trip only — no editor UI in Phase 1).
  // Each file is optional. We preserve the rows as-is so a v2-aware consumer
  // sees exactly what the publisher uploaded.
  const fareAreas: FareArea[] = await readFile('areas.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.area_id)
          .map((r) => ({ area_id: String(r.area_id), area_name: r.area_name || undefined }))
      : []
  );
  const stopAreas: StopArea[] = await readFile('stop_areas.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.area_id && r.stop_id)
          .map((r) => ({ area_id: String(r.area_id), stop_id: String(r.stop_id) }))
      : []
  );
  const fareNetworks: FareNetwork[] = await readFile('networks.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.network_id)
          .map((r) => ({ network_id: String(r.network_id), network_name: r.network_name || undefined }))
      : []
  );
  const routeNetworks: RouteNetwork[] = await readFile('route_networks.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.network_id && r.route_id)
          .map((r) => ({ network_id: String(r.network_id), route_id: String(r.route_id) }))
      : []
  );
  const timeframes: Timeframe[] = await readFile('timeframes.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.timeframe_group_id && r.service_id)
          .map((r) => ({
            timeframe_group_id: String(r.timeframe_group_id),
            start_time: r.start_time || undefined,
            end_time: r.end_time || undefined,
            service_id: String(r.service_id),
          }))
      : []
  );
  const riderCategories: RiderCategory[] = await readFile('rider_categories.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.rider_category_id && r.rider_category_name)
          .map((r) => ({
            rider_category_id: String(r.rider_category_id),
            rider_category_name: String(r.rider_category_name),
            is_default_fare_category: r.is_default_fare_category !== undefined && r.is_default_fare_category !== ''
              ? (num(r.is_default_fare_category) as 0 | 1)
              : undefined,
            eligibility_url: r.eligibility_url || undefined,
          }))
      : []
  );
  const fareMedia: FareMedia[] = await readFile('fare_media.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.fare_media_id)
          .map((r) => ({
            fare_media_id: String(r.fare_media_id),
            fare_media_name: r.fare_media_name || undefined,
            fare_media_type: (num(r.fare_media_type) as 0 | 1 | 2 | 3 | 4),
          }))
      : []
  );
  const fareProducts: FareProduct[] = await readFile('fare_products.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.fare_product_id)
          .map((r) => ({
            fare_product_id: String(r.fare_product_id),
            fare_product_name: r.fare_product_name || undefined,
            rider_category_id: r.rider_category_id || undefined,
            fare_media_id: r.fare_media_id || undefined,
            amount: String(r.amount ?? ''),
            currency: String(r.currency || 'USD'),
          }))
      : []
  );
  const fareLegRules: FareLegRule[] = await readFile('fare_leg_rules.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.fare_product_id)
          .map((r) => ({
            leg_group_id: r.leg_group_id || undefined,
            network_id: r.network_id || undefined,
            from_area_id: r.from_area_id || undefined,
            to_area_id: r.to_area_id || undefined,
            from_timeframe_group_id: r.from_timeframe_group_id || undefined,
            to_timeframe_group_id: r.to_timeframe_group_id || undefined,
            fare_product_id: String(r.fare_product_id),
            rule_priority: r.rule_priority !== undefined && r.rule_priority !== ''
              ? num(r.rule_priority)
              : undefined,
          }))
      : []
  );
  const fareTransferRules: FareTransferRule[] = await readFile('fare_transfer_rules.txt').then((t) =>
    t
      ? parseCSV(t)
          .filter((r) => r.fare_transfer_type !== undefined && r.fare_transfer_type !== '')
          .map((r) => ({
            from_leg_group_id: r.from_leg_group_id || undefined,
            to_leg_group_id: r.to_leg_group_id || undefined,
            transfer_count: r.transfer_count !== undefined && r.transfer_count !== ''
              ? num(r.transfer_count)
              : undefined,
            duration_limit: r.duration_limit !== undefined && r.duration_limit !== ''
              ? num(r.duration_limit)
              : undefined,
            duration_limit_type: r.duration_limit_type !== undefined && r.duration_limit_type !== ''
              ? (num(r.duration_limit_type) as 0 | 1)
              : undefined,
            fare_transfer_type: (num(r.fare_transfer_type) as 0 | 1 | 2),
            fare_product_id: r.fare_product_id || undefined,
          }))
      : []
  );

  // Build routeStops from stop_times: for each route, find unique stops in order
  const routeStops: RouteStop[] = [];
  const routeStopSet = new Set<string>();
  for (const route of routes) {
    const routeTrips = trips.filter((t) => t.route_id === route.route_id);
    for (const dir of [0, 1] as const) {
      const dirTrips = routeTrips.filter((t) => t.direction_id === dir);
      if (dirTrips.length === 0) continue;
      // Use the first trip's stop_times as the canonical order. One route_stop
      // per stop_time of that trip — including a stop the trip visits more than
      // once (a loop returning to its start). The dedup key includes
      // stop_sequence so a repeated stop_id at distinct sequences is preserved
      // as two route_stops, not collapsed into one.
      const firstTrip = dirTrips[0];
      const tripStopTimes = stopTimes
        .filter((st) => st.trip_id === firstTrip.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      for (const st of tripStopTimes) {
        const key = `${route.route_id}-${st.stop_id}-${dir}-${st.stop_sequence}`;
        if (!routeStopSet.has(key)) {
          routeStopSet.add(key);
          routeStops.push({
            route_id: route.route_id,
            stop_id: st.stop_id,
            direction_id: dir,
            stop_sequence: st.stop_sequence,
            _snapped: true,
            // Tag with the representative trip's shape so the editor keys stops
            // per shape (the common one-shape-per-direction case is 1:1).
            shape_id: firstTrip.shape_id,
          });
        }
      }
    }
  }

  // directions.txt (non-standard but widely supported)
  const directionsText = await readFile('directions.txt');
  if (directionsText) {
    const dirRows = parseCSV(directionsText);
    for (const row of dirRows) {
      const route = routes.find((r) => r.route_id === String(row.route_id));
      if (!route) continue;
      const dir = num(row.direction_id);
      if (dir === 0) route._direction_0_name = row.direction || undefined;
      else if (dir === 1) route._direction_1_name = row.direction || undefined;
    }
  } else {
    // Fallback: populate direction names from trip_headsign values
    for (const route of routes) {
      const routeTrips = trips.filter((t) => t.route_id === route.route_id);
      const dir0Trip = routeTrips.find((t) => t.direction_id === 0 && t.trip_headsign);
      const dir1Trip = routeTrips.find((t) => t.direction_id === 1 && t.trip_headsign);
      if (dir0Trip?.trip_headsign) route._direction_0_name = dir0Trip.trip_headsign;
      if (dir1Trip?.trip_headsign) route._direction_1_name = dir1Trip.trip_headsign;
    }
  }

  // ─── GTFS-Flex: locations.geojson + booking_rules.txt ────────────────────

  /**
   * Extract a flex location_id from a GeoJSON feature. The spec puts it in the
   * top-level `id` field (which is what we now export); feeds we exported
   * earlier carried it in `properties.stop_id`, so both are accepted.
   */
  const locationIdOf = (f: GeoJSON.Feature): string => {
    const p = (f.properties || {}) as Record<string, unknown>;
    return String(f.id ?? p.id ?? p.stop_id ?? '');
  };

  /**
   * Feeds we exported before the one-zone-one-location fix wrote each polygon of
   * a zone as its own feature — ids `${zoneId}-0`, `${zoneId}-1`, … carried in
   * `properties.stop_id`, never at the top level. Only features with exactly
   * that legacy shape (and a `-0` sibling) get the trailing `-N` stripped so
   * their polygons regroup into one zone. Everything else — our current export
   * and third-party flex feeds, which both carry a top-level `id` — maps 1:1, so
   * a zone whose own id ends in `-1` survives a round-trip unmangled.
   */
  const isLegacyFeatureId = (f: GeoJSON.Feature): boolean => {
    const p = (f.properties || {}) as Record<string, unknown>;
    return f.id == null && p.id == null && p.stop_id != null;
  };
  const zoneIdFromLocationId = (f: GeoJSON.Feature, loc: string, allIds: Set<string>): string => {
    if (!isLegacyFeatureId(f)) return loc;
    const base = loc.replace(/-\d+$/, '');
    return base !== loc && allIds.has(`${base}-0`) ? base : loc;
  };

  // booking_rules.txt → id → BookingRule
  const bookingRulesText = await readFile('booking_rules.txt');
  const bookingRuleMap = new Map<string, BookingRule>();
  if (bookingRulesText) {
    for (const row of parseCSV(bookingRulesText)) {
      const id = String(row.booking_rule_id || '');
      if (!id) continue;
      bookingRuleMap.set(id, {
        bookingType: (num(row.booking_type) as 0 | 1 | 2),
        priorNoticeDurationMin: row.prior_notice_duration_min ? num(row.prior_notice_duration_min) : undefined,
        priorNoticeDurationMax: row.prior_notice_duration_max ? num(row.prior_notice_duration_max) : undefined,
        priorNoticeLastDay: row.prior_notice_last_day ? num(row.prior_notice_last_day) : undefined,
        priorNoticeLastTime: row.prior_notice_last_time || undefined,
        priorNoticeStartDay: row.prior_notice_start_day ? num(row.prior_notice_start_day) : undefined,
        priorNoticeStartTime: row.prior_notice_start_time || undefined,
        priorNoticeServiceId: row.prior_notice_service_id || undefined,
        message: row.message || undefined,
        pickupMessage: row.pickup_message || undefined,
        dropOffMessage: row.drop_off_message || undefined,
        phoneNumber: row.phone_number || undefined,
        infoUrl: row.info_url || undefined,
        bookingUrl: row.booking_url || undefined,
      });
    }
  }

  // location_groups.txt + location_group_stops.txt → group flex zones.
  // Each group becomes a FlexZone with stopIds (no polygon geometry).
  const locationGroupsText = await readFile('location_groups.txt');
  const locationGroupStopsText = await readFile('location_group_stops.txt');
  const groupNameById = new Map<string, string>();
  const groupStopsById = new Map<string, string[]>();
  if (locationGroupsText) {
    for (const row of parseCSV(locationGroupsText)) {
      const id = String(row.location_group_id || '');
      if (!id) continue;
      groupNameById.set(id, row.location_group_name || id);
    }
  }
  if (locationGroupStopsText) {
    for (const row of parseCSV(locationGroupStopsText)) {
      const id = String(row.location_group_id || '');
      const sid = String(row.stop_id || '');
      if (!id || !sid) continue;
      const list = groupStopsById.get(id) || [];
      list.push(sid);
      groupStopsById.set(id, list);
    }
  }

  // locations.geojson → FlexZone[]
  const locationsText = await readFile('locations.geojson');
  const flexZones: FlexZone[] = [];

  const numOrU = (v: unknown) => (v === '' || v == null ? undefined : Number(v));

  /** stop_times pickup_type / drop_off_type on a flex row, when the feed sets one. */
  const flexTypeOrU = (v: unknown): 0 | 1 | 2 | 3 | undefined => {
    const n = numOrU(v);
    return n === 0 || n === 1 || n === 2 || n === 3 ? n : undefined;
  };

  /**
   * Travel within a single location or location group takes TWO stop_times
   * records on the same trip (same id, stop_sequence 1 and 2), so collapse a
   * zone's rows to one per trip before reading windows off them — otherwise the
   * second record would look like an extra service window.
   */
  const oneRowPerTrip = (rows: CsvRow[]): CsvRow[] => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const tid = String(r.trip_id || '');
      if (seen.has(tid)) return false;
      seen.add(tid);
      return true;
    });
  };

  /**
   * safe_duration_factor / safe_duration_offset are trips.txt fields. Feeds we
   * exported earlier wrote them on the flex stop_times row instead, so fall back
   * to that rather than silently dropping a user's values.
   */
  const safeDurationOf = (flexRow: CsvRow | undefined) => {
    const fromTrip = flexRow ? tripSafeDuration.get(String(flexRow.trip_id || '')) : undefined;
    return {
      factor: fromTrip?.factor ?? numOrU(flexRow?.safe_duration_factor),
      offset: fromTrip?.offset ?? numOrU(flexRow?.safe_duration_offset),
    };
  };

  // Track the set of trip_ids each emitted group zone references, so a
  // polygon zone whose flex stop_times row shares the same trip can be merged
  // into it (= a "mixed" polygon + group zone). Our exporter puts both rows on
  // the same trip; third-party mixed feeds do the same per the spec (one trip,
  // two stop_times rows: one location_id, one location_group_id).
  const groupZoneByTrip = new Map<string, FlexZone>();
  const groupZoneById = new Map<string, FlexZone>();

  // ── Group-based zones ─────────────────────────────────────────────
  for (const [groupId, stopIds] of groupStopsById) {
    const groupName = groupNameById.get(groupId) || groupId;
    const myGroupRows = flexStopTimeRows.filter(
      (r) => String(r.location_group_id) === groupId,
    );
    const flexRow = myGroupRows[0];
    const bookingId =
      flexRow?.pickup_booking_rule_id ||
      flexRow?.drop_off_booking_rule_id;
    const bookingRule = bookingId ? bookingRuleMap.get(String(bookingId)) : undefined;
    const pickupStart = flexRow?.start_pickup_drop_off_window;
    const pickupEnd = flexRow?.end_pickup_drop_off_window;

    let routeId: string | undefined;
    let serviceId: string | undefined;
    if (flexRow) {
      const trip = trips.find((t) => t.trip_id === String(flexRow.trip_id));
      if (trip) {
        routeId = trip.route_id;
        serviceId = trip.service_id;
      }
    }

    const safeDuration = safeDurationOf(flexRow);
    const zone: FlexZone = {
      // Mirror our own export's naming so a round-trip is stable.
      id: groupId.replace(/-group$/, ''),
      name: groupName,
      bufferMiles: 0,
      geojson: { type: 'FeatureCollection', features: [] },
      stopIds,
      bookingRule,
      pickupWindowStart: pickupStart || undefined,
      pickupWindowEnd: pickupEnd || undefined,
      pickupType: flexTypeOrU(flexRow?.pickup_type),
      dropOffType: flexTypeOrU(flexRow?.drop_off_type),
      serviceId,
      routeId,
      meanDurationFactor: numOrU(flexRow?.mean_duration_factor),
      meanDurationOffset: numOrU(flexRow?.mean_duration_offset),
      safeDurationFactor: safeDuration.factor,
      safeDurationOffset: safeDuration.offset,
    };
    flexZones.push(zone);
    groupZoneById.set(zone.id, zone);
    for (const r of myGroupRows) {
      const tid = String(r.trip_id || '');
      if (tid) groupZoneByTrip.set(tid, zone);
    }
  }
  if (locationsText) {
    try {
      const geo = JSON.parse(locationsText) as GeoJSON.FeatureCollection;
      // Group features by zone id (1:1 today; legacy exports split a zone's
      // polygons across `${zoneId}-N` features that regroup into one zone).
      const geoFeatures = (geo.features || []).filter((f) => locationIdOf(f));
      const allLocIds = new Set(geoFeatures.map((f) => locationIdOf(f)));
      const byZone = new Map<string, GeoJSON.Feature[]>();
      for (const f of geoFeatures) {
        const zoneId = zoneIdFromLocationId(f, locationIdOf(f), allLocIds);
        const list = byZone.get(zoneId) || [];
        list.push(f);
        byZone.set(zoneId, list);
      }
      // Build one FlexZone per group.
      for (const [zoneId, features] of byZone) {
        const first = features[0];
        const props = (first.properties || {}) as Record<string, unknown>;

        // Collect this zone's location_ids and all flex stop_times rows
        // that reference any of them. The first row sets the primary
        // window; subsequent rows become additionalWindows entries so a
        // zone with morning + evening shuttles round-trips faithfully.
        const myLocIds = new Set(features.map((f) => locationIdOf(f)));
        const myFlexRows = oneRowPerTrip(
          flexStopTimeRows.filter((r) => myLocIds.has(String(r.location_id))),
        );
        const flexRow = myFlexRows[0];
        const extraRows = myFlexRows.slice(1);

        const bookingId =
          flexRow?.pickup_booking_rule_id ||
          flexRow?.drop_off_booking_rule_id ||
          props.pickup_booking_rule_id ||
          props.drop_off_booking_rule_id;
        const bookingRule = bookingId ? bookingRuleMap.get(String(bookingId)) : undefined;

        const pickupStart = flexRow?.start_pickup_drop_off_window || props.start_pickup_drop_off_window;
        const pickupEnd = flexRow?.end_pickup_drop_off_window || props.end_pickup_drop_off_window;

        // Figure out this zone's trip and route (via stop_times.trip_id →
        // trips.route_id) and its service_id — so re-export preserves the
        // same route association and service pattern.
        let routeId: string | undefined;
        let serviceId: string | undefined;
        if (flexRow) {
          const trip = trips.find((t) => t.trip_id === String(flexRow.trip_id));
          if (trip) {
            routeId = trip.route_id;
            serviceId = trip.service_id;
          }
        }

        const additionalWindows = extraRows.map((r) => {
          const t = trips.find((t) => t.trip_id === String(r.trip_id));
          return {
            serviceId: t?.service_id || serviceId || '',
            pickupWindowStart: String(r.start_pickup_drop_off_window || ''),
            pickupWindowEnd: String(r.end_pickup_drop_off_window || ''),
          };
        }).filter((w) => w.pickupWindowStart && w.pickupWindowEnd && w.serviceId);

        // ── Mixed-zone merge ────────────────────────────────────────────
        // If these polygons belong to a flex trip that already produced a
        // group zone (or share its zone id), this is a single mixed zone:
        // fold the polygon geometry into the existing group zone rather than
        // creating a duplicate. The group zone keeps its stopIds; we add the
        // polygon features (and the polygon side's richer window data).
        const myTripIds = new Set(myFlexRows.map((r) => String(r.trip_id || '')));
        let mergeTarget: FlexZone | undefined = groupZoneById.get(zoneId);
        if (!mergeTarget) {
          for (const tid of myTripIds) {
            const z = groupZoneByTrip.get(tid);
            if (z) { mergeTarget = z; break; }
          }
        }
        if (mergeTarget) {
          mergeTarget.geojson = {
            type: 'FeatureCollection',
            features: [...(mergeTarget.geojson.features || []), ...features],
          };
          // Prefer concrete polygon-side window/route/service data when the
          // group side left them blank (e.g. third-party feed where the group
          // row omits the window but the polygon row carries it).
          mergeTarget.pickupWindowStart ||= pickupStart ? String(pickupStart) : undefined;
          mergeTarget.pickupWindowEnd ||= pickupEnd ? String(pickupEnd) : undefined;
          mergeTarget.serviceId ||= serviceId;
          mergeTarget.routeId ||= routeId;
          mergeTarget.bookingRule ||= bookingRule;
          mergeTarget.pickupType ??= flexTypeOrU(flexRow?.pickup_type);
          mergeTarget.dropOffType ??= flexTypeOrU(flexRow?.drop_off_type);
          mergeTarget.meanDurationFactor ??= numOrU(flexRow?.mean_duration_factor);
          mergeTarget.meanDurationOffset ??= numOrU(flexRow?.mean_duration_offset);
          mergeTarget.safeDurationFactor ??= safeDurationOf(flexRow).factor;
          mergeTarget.safeDurationOffset ??= safeDurationOf(flexRow).offset;
          if (additionalWindows.length > 0 && !mergeTarget.additionalWindows) {
            mergeTarget.additionalWindows = additionalWindows;
          }
          continue;
        }

        const safeDuration = safeDurationOf(flexRow);
        flexZones.push({
          id: zoneId,
          name: String(props.stop_name || props.name || zoneId),
          bufferMiles: 0,
          geojson: { type: 'FeatureCollection', features },
          bookingRule,
          pickupWindowStart: pickupStart ? String(pickupStart) : undefined,
          pickupWindowEnd: pickupEnd ? String(pickupEnd) : undefined,
          pickupType: flexTypeOrU(flexRow?.pickup_type),
          dropOffType: flexTypeOrU(flexRow?.drop_off_type),
          serviceId,
          routeId,
          meanDurationFactor: numOrU(flexRow?.mean_duration_factor),
          meanDurationOffset: numOrU(flexRow?.mean_duration_offset),
          safeDurationFactor: safeDuration.factor,
          safeDurationOffset: safeDuration.offset,
          additionalWindows: additionalWindows.length > 0 ? additionalWindows : undefined,
        });
      }
    } catch (e) {
      warnings.push(`Could not parse locations.geojson: ${(e as Error).message}`);
    }
  }

  report({ phase: 'Finalizing…' });
  // Strip the synthetic flex trips from trips[] so re-exporting doesn't
  // create a duplicate (materializeFlex regenerates them from the zones).
  const flexZoneRouteIds = new Set(flexZones.map((z) => z.routeId).filter(Boolean) as string[]);
  const tripsWithoutFlex = trips.filter((t) => !flexTripIds.has(t.trip_id));
  // Remove routes that ONLY existed to carry flex trips. If a route lost all
  // of its trips AND belongs to a flex zone, drop it — the zone re-creates
  // it on the next export.
  const routesWithoutFlex = routes.filter((r) => {
    if (!flexZoneRouteIds.has(r.route_id)) return true;
    const remainingTrips = tripsWithoutFlex.filter((t) => t.route_id === r.route_id);
    return remainingTrips.length > 0;
  });
  // A zone's fare rides on its synthesized route, so dropping that route would
  // strand the fare_rules row pointing at it. Absorb the fare back onto the
  // zone and drop the row; materializeFlex re-emits both on the next export.
  const droppedFlexRouteIds = new Set(
    routes
      .filter((r) => flexZoneRouteIds.has(r.route_id))
      .filter((r) => !routesWithoutFlex.some((kept) => kept.route_id === r.route_id))
      .map((r) => r.route_id),
  );
  for (const zone of flexZones) {
    if (!zone.routeId || !droppedFlexRouteIds.has(zone.routeId)) continue;
    const rule = fareRules.find((f) => f.route_id === zone.routeId && f.fare_id);
    if (rule) zone.fareId = rule.fare_id;
  }
  const fareRulesWithoutFlex = fareRules.filter(
    (f) => !(f.route_id && droppedFlexRouteIds.has(f.route_id)),
  );

  // Re-point flex zones that lost their route to the kept route (if any).
  for (const zone of flexZones) {
    if (zone.routeId && !routesWithoutFlex.some((r) => r.route_id === zone.routeId)) {
      zone.routeId = undefined;
    }
  }

  return {
    agencies, calendars, calendarDates,
    routes: routesWithoutFlex, shapes, stops,
    trips: tripsWithoutFlex, stopTimes, feedInfo,
    routeStops, fareAttributes, fareRules: fareRulesWithoutFlex, transfers,
    frequencies, levels, pathways,
    fareAreas, stopAreas, fareNetworks, routeNetworks,
    timeframes, riderCategories, fareMedia,
    fareProducts, fareLegRules, fareTransferRules,
    flexZones, warnings,
  };
}


/** The fully-parsed feed returned by importGtfsZip — the shape that flows into
 * loadImportIntoStore / mergeImportIntoStore. */
export type ImportData = Awaited<ReturnType<typeof importGtfsZip>>;

// ── Web Worker message protocol ───────────────────────────────────────────
// Shared by gtfsImport.worker.ts and the parseGtfsInWorker client in
// gtfsImport.ts. Kept here (store-free module) so the worker never pulls in
// the Zustand store.
export type ImportWorkerRequest = { file: File };
export type ImportWorkerResponse =
  | { type: 'progress'; phase: string; rows?: number }
  | { type: 'result'; data: ImportData }
  | { type: 'error'; message: string };
