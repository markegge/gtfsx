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
  /** GeoJSON FeatureCollection of Polygon features making up the service area. */
  geojson: GeoJSON.FeatureCollection;
  /** Optional booking rule. Exported to booking_rules.txt with id `${zone.id}-booking`. */
  bookingRule?: BookingRule;
  /** Optional pickup window (HH:MM:SS) when the zone is in service. */
  pickupWindowStart?: string;
  pickupWindowEnd?: string;
  /** Optional drop-off window (HH:MM:SS); often the same as pickup. */
  dropOffWindowStart?: string;
  dropOffWindowEnd?: string;
  /**
   * Days of week the service runs. Used at export time to materialize a
   * calendar.txt entry + flex trip. If undefined, defaults to all 7 days.
   */
  daysOfWeek?: {
    mon: boolean; tue: boolean; wed: boolean; thu: boolean;
    fri: boolean; sat: boolean; sun: boolean;
  };
  /**
   * Optional route_id from routes.txt. If unset, the export step
   * auto-creates a route per flex zone.
   */
  routeId?: string;
  /** Optional fare reference — fare_id from fare_attributes.txt. */
  fareId?: string;
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
