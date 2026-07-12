import type { StateCreator } from 'zustand';

/**
 * GTFS-Flex booking_rules.txt fields (gtfs.org/community/extensions/flex).
 * One booking rule per zone is the typical pattern; agencies running
 * multiple service modes can manage them per-zone.
 */
export interface BookingRule {
  /** 0 = real-time, 1 = same-day (with prior notice), 2 = prior day(s). */
  bookingType: 0 | 1 | 2;
  /** Minimum minutes of advance notice (booking_type=1 only). */
  priorNoticeDurationMin?: number;
  /** Optional maximum advance booking, in minutes (booking_type=1). */
  priorNoticeDurationMax?: number;
  /** Days before service when booking closes (booking_type=2). */
  priorNoticeLastDay?: number;
  /** Time of day (HH:MM:SS) when booking closes on the cutoff day. */
  priorNoticeLastTime?: string;
  /** Days before when booking opens (booking_type=2, optional). */
  priorNoticeStartDay?: number;
  priorNoticeStartTime?: string;
  /** service_id whose days are counted for prior notice (booking_type=2 only). */
  priorNoticeServiceId?: string;
  /** Rider-facing instruction text (shown in trip planners). */
  message?: string;
  pickupMessage?: string;
  dropOffMessage?: string;
  phoneNumber?: string;
  infoUrl?: string;
  bookingUrl?: string;
}

export interface FlexZone {
  id: string;
  name: string;
  bufferMiles: number;
  /**
   * GeoJSON FeatureCollection of Polygon features making up the service
   * area. Non-empty for polygon-based zones; may be empty for group-only
   * zones (where `stopIds` is the authoritative service area). A "mixed"
   * zone carries BOTH polygon features here AND a stop group in `stopIds`.
   */
  geojson: GeoJSON.FeatureCollection;
  /**
   * Optional list of stop_id values that make up a named stop-group service
   * area (exported as `location_groups.txt` + `location_group_stops.txt`).
   * When present (even if empty), the zone has a stop-group component, and
   * the export emits a flex stop_times row referencing `location_group_id`.
   *
   * A zone may have polygon geometry (`geojson.features`) AND a stop group
   * (`stopIds`) at the same time — a "mixed" zone. In GTFS-Flex a single
   * stop_times row references one location_id OR one location_group_id (never
   * both), so a mixed zone materializes to two stop_times rows on the same
   * flex trip: one for the polygon area(s) and one for the stop group. See
   * `flexZoneShape` for the canonical polygon/group/mixed classification.
   */
  stopIds?: string[];
  /** Optional booking rule. Exported to booking_rules.txt with id `${zone.id}-booking`. */
  bookingRule?: BookingRule;
  /** Optional pickup/drop-off window (HH:MM:SS) when the zone is in service. */
  pickupWindowStart?: string;
  pickupWindowEnd?: string;
  /**
   * stop_times pickup_type / drop_off_type for the zone's flex rows. Defaults
   * to 2 ("phone the agency") — the canonical on-demand value. With a window
   * defined the spec forbids pickup_type 0 and 3, and drop_off_type 0, so the
   * export clamps those back to 2.
   */
  pickupType?: 0 | 1 | 2 | 3;
  dropOffType?: 0 | 1 | 2 | 3;
  /**
   * service_id from calendar.txt that governs when this zone runs. Picked
   * from the service patterns the user has defined in the Calendars tab.
   * Required at export time for the flex trip; the UI falls back to the
   * first available service_id if the user hasn't picked one yet.
   */
  serviceId?: string;
  /**
   * Optional route_id from routes.txt. If unset, the export step
   * auto-creates a route per flex zone.
   */
  routeId?: string;
  /** Optional fare reference — fare_id from fare_attributes.txt. */
  fareId?: string;
  /**
   * GTFS-Flex trips.txt travel-time estimators used by trip planners to give
   * ETA ranges for on-demand legs. The factor is a dimensionless multiplier;
   * the offset is in seconds.
   */
  safeDurationFactor?: number;
  safeDurationOffset?: number;
  /**
   * Legacy: mean_duration_factor / mean_duration_offset were dropped from the
   * flex spec before adoption. Still parsed from feeds that carry them (so a
   * user's data isn't silently discarded on import) but never written back.
   */
  meanDurationFactor?: number;
  meanDurationOffset?: number;
  /**
   * Additional service windows beyond the primary one. Each entry
   * materializes to its own flex trip (distinct trip_id, own service_id,
   * own stop_times row referencing the same location/group). Useful when
   * a zone runs e.g. both a morning and an evening shuttle with different
   * hours and different service patterns.
   */
  additionalWindows?: Array<{
    serviceId: string;
    pickupWindowStart: string;
    pickupWindowEnd: string;
  }>;
}

/** A flex zone's authoritative service-area shape. */
export type FlexZoneShape = 'polygon' | 'group' | 'mixed' | 'empty';

/** True when the zone has at least one polygon feature. */
export function flexZoneHasPolygons(z: FlexZone): boolean {
  return (z.geojson?.features?.length ?? 0) > 0;
}

/**
 * True when the zone has a stop-group component. `stopIds` being an array at
 * all (even empty) marks the zone as group-bearing — matching the existing
 * "Create Stop Group" flow, which seeds `stopIds: []` before any stops are
 * added so the Details panel shows the stop picker.
 */
export function flexZoneHasGroup(z: FlexZone): boolean {
  return Array.isArray(z.stopIds);
}

/**
 * Canonical classification used by the editor UI, export, and validation:
 *  - 'mixed'   — has BOTH polygon geometry and a stop group
 *  - 'group'   — stop group only (no polygons)
 *  - 'polygon' — polygon geometry only
 *  - 'empty'   — neither (a freshly-created zone awaiting geometry)
 *
 * NOTE: a mixed zone's group may currently be empty (stopIds === []) while the
 * user is still adding stops; that still classifies as 'mixed' so the export
 * keeps both shape slots and the UI shows both editors.
 */
export function flexZoneShape(z: FlexZone): FlexZoneShape {
  const poly = flexZoneHasPolygons(z);
  const group = flexZoneHasGroup(z);
  if (poly && group) return 'mixed';
  if (group) return 'group';
  if (poly) return 'polygon';
  return 'empty';
}

export interface FlexSlice {
  flexZones: FlexZone[];
  addFlexZone: (zone: FlexZone) => void;
  updateFlexZone: (id: string, updates: Partial<FlexZone>) => void;
  updateFlexZoneBooking: (id: string, updates: Partial<BookingRule>) => void;
  removeFlexZone: (id: string) => void;
  setFlexZones: (zones: FlexZone[]) => void;
  /** Attach a stop-group component to a zone (seeds an empty `stopIds`). */
  addFlexZoneGroup: (id: string) => void;
  /** Detach the stop-group component (clears `stopIds`). */
  removeFlexZoneGroup: (id: string) => void;
  /** Clear all polygon geometry from a zone (keeps any stop group). */
  clearFlexZonePolygons: (id: string) => void;
}

export const createFlexSlice: StateCreator<FlexSlice, [['zustand/immer', never]], [], FlexSlice> = (set) => ({
  flexZones: [],
  addFlexZone: (zone) => set((state) => { state.flexZones.push(zone); }),
  updateFlexZone: (id, updates) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx !== -1) Object.assign(state.flexZones[idx], updates);
  }),
  updateFlexZoneBooking: (id, updates) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx === -1) return;
    const existing = state.flexZones[idx].bookingRule ?? { bookingType: 1 as 0 | 1 | 2 };
    state.flexZones[idx].bookingRule = { ...existing, ...updates };
  }),
  removeFlexZone: (id) => set((state) => {
    state.flexZones = state.flexZones.filter((z) => z.id !== id);
  }),
  setFlexZones: (zones) => set((state) => { state.flexZones = zones; }),
  addFlexZoneGroup: (id) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx === -1) return;
    if (!Array.isArray(state.flexZones[idx].stopIds)) {
      state.flexZones[idx].stopIds = [];
    }
  }),
  removeFlexZoneGroup: (id) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx === -1) return;
    state.flexZones[idx].stopIds = undefined;
  }),
  clearFlexZonePolygons: (id) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx === -1) return;
    state.flexZones[idx].geojson = { type: 'FeatureCollection', features: [] };
    state.flexZones[idx].bufferMiles = 0;
  }),
});
