import type { StateCreator } from 'zustand';

/**
 * GTFS-Flex booking_rules.txt fields (gtfs.org/community/extensions/flex).
 *
 * A rule has an identity (`id` + `name`) so ONE rule can be shared by many
 * zones — an agency running five zones off a single call centre defines the
 * rule once and attaches it everywhere, and the export writes one
 * booking_rules.txt row that every zone's stop_times reference.
 *
 * The rule is stored ON each zone that uses it (zones sharing a rule carry
 * equal copies keyed by the same `id`); `flexBookingRules` derives the library
 * from the zones. Keeping the zones the single source of truth means booking
 * rules ride along with every existing flexZones persistence, undo/redo, and
 * snapshot path for free, and no zone can ever end up pointing at a rule that
 * isn't there. The store actions below are the only writers, and they keep the
 * copies of a shared rule in lockstep.
 *
 * `id` / `name` are optional so a rule built by older code (or a test) still
 * type-checks; `migrateFlexZones` backfills both whenever zones enter the store.
 */
export interface BookingRule {
  /** Library identity. Exported as booking_rules.txt `booking_rule_id`. */
  id?: string;
  /** User-facing label. UI-only — booking_rules.txt has no name field. */
  name?: string;
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
  /**
   * The booking rule this zone uses, if any. Zones that share a rule carry
   * equal copies with the same `bookingRule.id`, and the export emits one
   * booking_rules.txt row per id. A rule with no id yet (legacy data) exports
   * under the derived id `${zone.id}-booking`, as it always has.
   */
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

// ── Booking-rule library ────────────────────────────────────────────────────

/**
 * The booking_rule_id this zone's rule exports under. Rules created before the
 * library existed carry no id; they keep the id the exporter has always derived
 * from the zone, so a feed re-exported after the upgrade is byte-identical.
 */
export function bookingRuleIdOf(zone: FlexZone): string | undefined {
  if (!zone.bookingRule) return undefined;
  return zone.bookingRule.id || `${zone.id}-booking`;
}

/** Every distinct booking rule the zones reference, in first-use order. */
export function flexBookingRules(zones: FlexZone[]): BookingRule[] {
  const byId = new Map<string, BookingRule>();
  for (const z of zones) {
    const id = bookingRuleIdOf(z);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...z.bookingRule!, id, name: z.bookingRule!.name || id });
  }
  return [...byId.values()];
}

/** The zones using a given rule — the "used by N zones" count in the UI. */
export function bookingRuleZones(zones: FlexZone[], ruleId: string): FlexZone[] {
  return zones.filter((z) => bookingRuleIdOf(z) === ruleId);
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * A booking_rule_id that no other rule in the library is using. Prefers
 * `${zoneId}-booking` — what the exporter has always derived — so the common
 * one-rule-per-zone feed keeps its ids across the upgrade.
 */
function freeBookingRuleId(zones: FlexZone[], zoneId: string): string {
  const taken = new Set(flexBookingRules(zones).map((r) => r.id!));
  const base = `${slugify(zoneId) || 'flex'}-booking`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Fields each booking_type permits (gtfs.org/community/extensions/flex). */
const ALLOWED_PRIOR_NOTICE_FIELDS: Record<0 | 1 | 2, Array<keyof BookingRule>> = {
  // Real-time booking takes no prior notice at all.
  0: [],
  // Same-day: duration_min (required) + duration_max, and start_day/_time.
  1: ['priorNoticeDurationMin', 'priorNoticeDurationMax', 'priorNoticeStartDay', 'priorNoticeStartTime'],
  // Prior-day: last_day/_time (required), start_day/_time, and the service_id
  // whose days the notice is counted against.
  2: ['priorNoticeLastDay', 'priorNoticeLastTime', 'priorNoticeStartDay', 'priorNoticeStartTime', 'priorNoticeServiceId'],
};

const PRIOR_NOTICE_FIELDS = Object.values(ALLOWED_PRIOR_NOTICE_FIELDS).flat();

/**
 * Drop every prior_notice_* field the new booking_type forbids. Without this a
 * rule switched from same-day to prior-day keeps its prior_notice_duration_min
 * and exports a feed the canonical validator ERRORs on — the field is Forbidden
 * under booking_type=2.
 */
export function clearForbiddenBookingFields(rule: BookingRule): BookingRule {
  const allowed = new Set<keyof BookingRule>(ALLOWED_PRIOR_NOTICE_FIELDS[rule.bookingType] ?? []);
  const next: BookingRule = { ...rule };
  for (const field of PRIOR_NOTICE_FIELDS) {
    if (!allowed.has(field)) delete next[field];
  }
  return next;
}

/**
 * Bring zones from any older shape up to the current one, on every path that
 * loads them (import, IndexedDB, server project, snapshot restore).
 *
 * Today that means one thing: a zone carrying an inline booking rule with no
 * identity gets the id the exporter already derived for it plus a name, which
 * lifts it into the library — same rule, same exported ids, now shareable.
 */
export function migrateFlexZones(zones: FlexZone[]): FlexZone[] {
  return zones.map((z) => {
    if (!z.bookingRule || (z.bookingRule.id && z.bookingRule.name)) return z;
    const id = bookingRuleIdOf(z)!;
    return {
      ...z,
      bookingRule: {
        ...z.bookingRule,
        id,
        name: z.bookingRule.name || (z.name ? `${z.name} booking` : id),
      },
    };
  });
}

export interface FlexSlice {
  flexZones: FlexZone[];
  addFlexZone: (zone: FlexZone) => void;
  updateFlexZone: (id: string, updates: Partial<FlexZone>) => void;
  updateFlexZoneBooking: (id: string, updates: Partial<BookingRule>) => void;
  /** Point a zone at an existing library rule (shares it). */
  attachBookingRule: (zoneId: string, ruleId: string) => void;
  /** Remove the zone's booking rule. Other zones sharing it are untouched. */
  detachBookingRule: (zoneId: string) => void;
  /** Give a zone its own new rule, seeded from `seed` (e.g. the agency phone). */
  createBookingRule: (zoneId: string, seed?: Partial<BookingRule>) => void;
  /** Rename a rule everywhere it's used. */
  renameBookingRule: (ruleId: string, name: string) => void;
  /** Delete a rule by detaching it from every zone that uses it. */
  deleteBookingRule: (ruleId: string) => void;
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
  addFlexZone: (zone) => set((state) => { state.flexZones.push(migrateFlexZones([zone])[0]); }),
  updateFlexZone: (id, updates) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx !== -1) Object.assign(state.flexZones[idx], updates);
  }),
  updateFlexZoneBooking: (id, updates) => set((state) => {
    const zone = state.flexZones.find((z) => z.id === id);
    if (!zone) return;
    const existing = zone.bookingRule ?? { bookingType: 1 as 0 | 1 | 2 };
    let next: BookingRule = { ...existing, ...updates };
    // Switching booking_type strands the fields the previous type used and the
    // new one forbids — clear them here, at the one place a type can change.
    if (updates.bookingType !== undefined && updates.bookingType !== existing.bookingType) {
      next = clearForbiddenBookingFields(next);
    }
    next.id ||= freeBookingRuleId(state.flexZones, zone.id);
    next.name ||= zone.name ? `${zone.name} booking` : next.id;
    // A rule may be shared: write the edit to every zone using it, so the
    // library never holds two versions of the same rule.
    for (const z of state.flexZones) {
      if (z.id === zone.id || bookingRuleIdOf(z) === next.id) z.bookingRule = { ...next };
    }
  }),
  attachBookingRule: (zoneId, ruleId) => set((state) => {
    const zone = state.flexZones.find((z) => z.id === zoneId);
    const rule = flexBookingRules(state.flexZones).find((r) => r.id === ruleId);
    if (!zone || !rule) return;
    zone.bookingRule = { ...rule };
  }),
  detachBookingRule: (zoneId) => set((state) => {
    const zone = state.flexZones.find((z) => z.id === zoneId);
    if (zone) zone.bookingRule = undefined;
  }),
  createBookingRule: (zoneId, seed) => set((state) => {
    const zone = state.flexZones.find((z) => z.id === zoneId);
    if (!zone) return;
    const id = freeBookingRuleId(state.flexZones, zone.id);
    zone.bookingRule = {
      bookingType: 1,
      ...seed,
      id,
      name: seed?.name || (zone.name ? `${zone.name} booking` : id),
    };
  }),
  renameBookingRule: (ruleId, name) => set((state) => {
    for (const z of state.flexZones) {
      if (bookingRuleIdOf(z) === ruleId) z.bookingRule = { ...z.bookingRule!, id: ruleId, name };
    }
  }),
  deleteBookingRule: (ruleId) => set((state) => {
    for (const z of state.flexZones) {
      if (bookingRuleIdOf(z) === ruleId) z.bookingRule = undefined;
    }
  }),
  removeFlexZone: (id) => set((state) => {
    state.flexZones = state.flexZones.filter((z) => z.id !== id);
  }),
  setFlexZones: (zones) => set((state) => { state.flexZones = migrateFlexZones(zones); }),
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
