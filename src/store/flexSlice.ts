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
   * area. REQUIRED for polygon-based zones; empty FeatureCollection for
   * group-based zones (where `stopIds` is the authoritative service area).
   */
  geojson: GeoJSON.FeatureCollection;
  /**
   * Optional: for group-based zones this is the list of stop_id values that
   * make up the flex service area (exported as `location_groups.txt` +
   * `location_group_stops.txt`). When set, the zone's flex stop_times row
   * references `location_group_id` instead of `location_id`.
   *
   * Mutually exclusive with geojson features — a zone is either polygon or
   * group, not both.
   */
  stopIds?: string[];
  /** Optional booking rule. Exported to booking_rules.txt with id `${zone.id}-booking`. */
  bookingRule?: BookingRule;
  /** Optional pickup window (HH:MM:SS) when the zone is in service. */
  pickupWindowStart?: string;
  pickupWindowEnd?: string;
  /** Optional drop-off window (HH:MM:SS); often the same as pickup. */
  dropOffWindowStart?: string;
  dropOffWindowEnd?: string;
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
   * GTFS-Flex stop_times travel-time estimators used by trip planners to
   * give ETA ranges for on-demand legs. Factors are dimensionless
   * multipliers; offsets are seconds.
   */
  meanDurationFactor?: number;
  meanDurationOffset?: number;
  safeDurationFactor?: number;
  safeDurationOffset?: number;
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

export interface FlexSlice {
  flexZones: FlexZone[];
  addFlexZone: (zone: FlexZone) => void;
  updateFlexZone: (id: string, updates: Partial<FlexZone>) => void;
  updateFlexZoneBooking: (id: string, updates: Partial<BookingRule>) => void;
  removeFlexZone: (id: string) => void;
  setFlexZones: (zones: FlexZone[]) => void;
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
});
