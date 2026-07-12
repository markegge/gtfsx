import { useStore } from '../../store';
import type { FlexZone, BookingRule } from '../../store/flexSlice';
import {
  bookingRuleIdOf, bookingRuleZones, flexBookingRules,
  flexZoneHasGroup, flexZoneHasPolygons,
} from '../../store/flexSlice';

interface Props {
  zone: FlexZone;
}

const BOOKING_TYPES: { value: 0 | 1 | 2; label: string; hint: string }[] = [
  { value: 0, label: 'Real-time', hint: 'No advance notice required' },
  { value: 1, label: 'Same-day', hint: 'Minimum minutes of notice' },
  { value: 2, label: 'Prior day', hint: 'Booking closes day(s) before service' },
];

/**
 * stop_times pickup_type / drop_off_type, in rider terms. A row with a
 * pickup/drop-off window (every flex row we export has one) may not use
 * pickup_type 0 or 3, nor drop_off_type 0 — hence the asymmetric option lists.
 */
const PICKUP_TYPES: { value: 1 | 2; label: string }[] = [
  { value: 2, label: 'Phone the agency' },
  { value: 1, label: 'Not available' },
];

const DROP_OFF_TYPES: { value: 1 | 2 | 3; label: string }[] = [
  { value: 2, label: 'Phone the agency' },
  { value: 3, label: 'Coordinate with the driver' },
  { value: 1, label: 'Not available' },
];

const NEW_RULE = '__new__';

/**
 * Why the last remaining shape's "Remove" is disabled. A zone with neither a
 * polygon nor a stop group has no service area to export, so the panel keeps a
 * floor of one — but the button never said so.
 */
const SHAPE_FLOOR_HINT =
  'A zone needs at least one shape. Add a stop group first, or delete the whole zone.';
const GROUP_FLOOR_HINT =
  'A zone needs at least one shape. Add a polygon first, or delete the whole zone.';

function describeServicePattern(c: {
  monday: 0 | 1; tuesday: 0 | 1; wednesday: 0 | 1; thursday: 0 | 1;
  friday: 0 | 1; saturday: 0 | 1; sunday: 0 | 1;
}): string {
  const daysShort = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const flags = [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday];
  const active = flags.reduce<string[]>((acc, v, i) => (v ? [...acc, daysShort[i]] : acc), []);
  if (active.length === 7) return 'Every day';
  if (active.length === 0) return 'No days';
  // Common patterns
  const key = flags.join('');
  if (key === '1111100') return 'Weekdays';
  if (key === '0000011') return 'Weekends';
  if (key === '1111110') return 'Mon–Sat';
  return active.join(' ');
}

export function FlexZoneDetails({ zone }: Props) {
  const {
    updateFlexZone, updateFlexZoneBooking, fareAttributes, calendars, calendarDates,
    stops, agencies, setSidebarSection, flexZones,
    attachBookingRule, detachBookingRule, createBookingRule,
    renameBookingRule, deleteBookingRule,
    addFlexZoneGroup, removeFlexZoneGroup, clearFlexZonePolygons, setMapMode,
  } = useStore();
  const hasGroup = flexZoneHasGroup(zone);
  const hasPolygons = flexZoneHasPolygons(zone);

  // Begin drawing a polygon that gets appended to THIS zone (turning a
  // group-only zone into a mixed polygon + group zone, or adding another
  // polygon to a polygon zone). MapView reads __flexAddPolygonZoneId on draw
  // complete and appends the feature instead of creating a new zone.
  const drawPolygonIntoZone = () => {
    window.__flexAddPolygonZoneId = zone.id;
    setMapMode('draw_flex_zone');
  };

  // A service_id may be defined in calendar.txt, calendar_dates.txt, or both.
  // Surface everything so the user can attach a zone to a dates-only service.
  const calendarIdSet = new Set(calendars.map((c) => c.service_id));
  const datesOnlyServiceIds = Array.from(
    new Set(calendarDates.map((d) => d.service_id)),
  ).filter((id) => !calendarIdSet.has(id));
  const rule = zone.bookingRule;
  const b: Partial<BookingRule> = rule ?? { bookingType: 1 };
  // The booking-rule library: every rule any zone uses, so one call centre's
  // rule can be attached to all five of its zones instead of retyped five times.
  const library = flexBookingRules(flexZones);
  const ruleId = bookingRuleIdOf(zone);
  const sharedCount = ruleId ? bookingRuleZones(flexZones, ruleId).length : 0;
  // What the exporter will actually write: with a window defined the spec
  // forbids pickup_type 0/3 and drop_off_type 0, so an imported feed carrying
  // one shows here as the 2 it exports as.
  const pickupType = zone.pickupType === 1 ? 1 : 2;
  const dropOffType = zone.dropOffType === 1 || zone.dropOffType === 3 ? zone.dropOffType : 2;

  const setField = <K extends keyof FlexZone>(k: K, v: FlexZone[K]) =>
    updateFlexZone(zone.id, { [k]: v } as Partial<FlexZone>);

  /**
   * A new rule pre-seeds the rider-facing contact fields from the primary
   * agency: booking phone ← agency_phone, info URL ← agency_url. Only fields
   * the agency actually sets are seeded.
   */
  const agencySeed = (): Partial<BookingRule> => {
    const agency = agencies[0];
    const seed: Partial<BookingRule> = {};
    if (agency?.agency_phone) seed.phoneNumber = agency.agency_phone;
    if (agency?.agency_url) seed.infoUrl = agency.agency_url;
    return seed;
  };

  const setBooking = <K extends keyof BookingRule>(k: K, v: BookingRule[K]) => {
    // The field the user is editing right now always wins over the seed (it's
    // spread last). Once the rule exists we never re-seed, so a value the user
    // typed or cleared is never overwritten. Editing a SHARED rule updates it
    // for every zone using it — that's the point of the library, and the panel
    // says so ("Used by N zones") right above these fields.
    const update: Partial<BookingRule> = rule ? { [k]: v } : { ...agencySeed(), [k]: v };
    updateFlexZoneBooking(zone.id, update);
  };

  const pickRule = (value: string) => {
    if (value === '') detachBookingRule(zone.id);
    else if (value === NEW_RULE) createBookingRule(zone.id, agencySeed());
    else attachBookingRule(zone.id, value);
  };

  const removeRule = () => {
    if (!ruleId) return;
    // Deleting a rule other zones rely on would break their booking info, so
    // say who else loses it before doing anything.
    if (sharedCount > 1 && !window.confirm(
      `"${b.name || ruleId}" is used by ${sharedCount} zones. Delete it and leave all ${sharedCount} without a booking rule?`,
    )) return;
    deleteBookingRule(ruleId);
  };

  const addStop = (stopId: string) => {
    if (!stopId) return;
    const current = zone.stopIds || [];
    if (current.includes(stopId)) return;
    setField('stopIds', [...current, stopId]);
  };

  const removeStop = (stopId: string) => {
    if (!zone.stopIds) return;
    setField('stopIds', zone.stopIds.filter((s) => s !== stopId));
  };

  return (
    <div className="px-3 pb-3 pt-1 space-y-3 bg-purple-50/30 border-l-2 border-purple-200">
      {/* Service area composition: polygon area(s) and/or a stop group. A
          zone may carry both (a "mixed" zone) — each exports independently
          (locations.geojson + location_groups.txt) and both are referenced
          from the same flex trip. */}
      <div>
        <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
          Service Area
        </div>

        {/* Polygon component */}
        <div className="bg-white border border-sand rounded p-2 mb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-dark-brown">
              Polygon area{hasPolygons ? `s · ${zone.geojson.features.length}` : ''}
            </span>
            {hasPolygons ? (
              <div className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={drawPolygonIntoZone}
                  className="px-1.5 py-0.5 text-[11px] font-semibold text-purple hover:bg-purple-50 rounded"
                  title="Draw another polygon into this zone"
                >
                  + Polygon
                </button>
                {/* A disabled button fires no mouse events, so the "why" tooltip
                    goes on a wrapper — and is repeated inline below, since a
                    tooltip alone is easy to miss. */}
                <span title={hasGroup ? undefined : SHAPE_FLOOR_HINT}>
                  <button
                    type="button"
                    onClick={() => clearFlexZonePolygons(zone.id)}
                    className="px-1.5 py-0.5 text-[11px] text-warm-gray hover:text-red-500 rounded disabled:text-warm-gray/40 disabled:hover:text-warm-gray/40 disabled:cursor-not-allowed"
                    title={hasGroup ? 'Remove all polygon geometry' : undefined}
                    disabled={!hasGroup}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={drawPolygonIntoZone}
                className="px-1.5 py-0.5 text-[11px] font-semibold text-purple hover:bg-purple-50 rounded shrink-0"
                title="Draw a polygon service area into this zone"
              >
                + Add polygon
              </button>
            )}
          </div>
          {hasPolygons ? (
            <>
              <p className="text-[10px] text-warm-gray/80 mt-1">
                Exported to <code>locations.geojson</code>. Edit shape on the map via "Edit Shape".
              </p>
              {/* The zone id IS the location id: it's written as the top-level
                  `id` of the zone's locations.geojson Feature, and it's what the
                  flex stop_times rows reference. Surfaced read-only so a user can
                  correlate the panel with the exported feed. */}
              <p className="text-[10px] text-warm-gray/80 mt-1">
                <span className="text-warm-gray/60">location_id:</span>{' '}
                <code className="font-mono text-dark-brown select-all">{zone.id}</code>
              </p>
              <p className="text-[10px] text-warm-gray/60">
                What <code>stop_times.location_id</code> references in the exported feed.
              </p>
            </>
          ) : (
            <p className="text-[10px] text-warm-gray/80 mt-1">
              No polygon yet. Add one to cover an on-demand area.
            </p>
          )}
          {hasPolygons && !hasGroup && (
            <p className="text-[10px] text-warm-gray/60 mt-0.5">
              Remove is disabled — a zone needs at least one shape. Add a stop group
              below (which also makes this a mixed zone), or delete the whole zone.
            </p>
          )}
        </div>

        {/* Stop-group component */}
        <div className="bg-white border border-sand rounded p-2">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-xs font-semibold text-dark-brown">
              Stop group{hasGroup ? ` · ${zone.stopIds?.length || 0}` : ''}
            </span>
            {hasGroup ? (
              <span className="shrink-0" title={hasPolygons ? undefined : GROUP_FLOOR_HINT}>
                <button
                  type="button"
                  onClick={() => removeFlexZoneGroup(zone.id)}
                  className="px-1.5 py-0.5 text-[11px] text-warm-gray hover:text-red-500 rounded disabled:text-warm-gray/40 disabled:hover:text-warm-gray/40 disabled:cursor-not-allowed"
                  title={hasPolygons ? 'Remove the stop group from this zone' : undefined}
                  disabled={!hasPolygons}
                >
                  Remove
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => addFlexZoneGroup(zone.id)}
                className="px-1.5 py-0.5 text-[11px] font-semibold text-purple hover:bg-purple-50 rounded shrink-0"
                title="Add a named stop group to this zone"
              >
                + Add stop group
              </button>
            )}
          </div>

          {hasGroup && (
            <>
              {zone.stopIds && zone.stopIds.length > 0 ? (
                <ul className="bg-cream border border-sand rounded divide-y divide-sand mb-2 max-h-36 overflow-y-auto">
                  {zone.stopIds.map((sid) => {
                    const stop = stops.find((s) => s.stop_id === sid);
                    return (
                      <li key={sid} className="flex items-center justify-between gap-2 px-2 py-1">
                        <span className="text-xs text-dark-brown truncate">
                          {stop ? (stop.stop_name || stop.stop_id) : sid}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeStop(sid)}
                          className="text-[11px] text-warm-gray hover:text-red-500 shrink-0"
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[11px] text-warm-gray mb-2">No stops added yet.</p>
              )}
              <select
                value=""
                onChange={(e) => { addStop(e.target.value); e.target.value = ''; }}
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              >
                <option value="">— Add a stop —</option>
                {stops
                  .filter((s) => !(zone.stopIds || []).includes(s.stop_id))
                  .map((s) => (
                    <option key={s.stop_id} value={s.stop_id}>
                      {s.stop_name || s.stop_id}
                    </option>
                  ))}
              </select>
              <p className="text-[10px] text-warm-gray/80 mt-1">
                Exported as <code>location_groups.txt</code> + <code>location_group_stops.txt</code>; the flex trip references <code>location_group_id</code>.
              </p>
              {!hasPolygons && (
                <p className="text-[10px] text-warm-gray/60 mt-0.5">
                  Remove is disabled — a zone needs at least one shape. Add a polygon
                  above, or delete the whole zone.
                </p>
              )}
            </>
          )}
          {!hasGroup && (
            <p className="text-[10px] text-warm-gray/80">
              No stop group. Add one to serve a named set of stops{hasPolygons ? ' alongside the polygon area' : ''}.
            </p>
          )}
        </div>
      </div>

      {/* Service window + days */}
      <div>
        <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
          Service Schedule
        </div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Pickup start</label>
            <input
              type="text"
              placeholder="HH:MM:SS"
              value={zone.pickupWindowStart || ''}
              onChange={(e) => setField('pickupWindowStart', e.target.value || undefined)}
              className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
            />
          </div>
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Pickup end</label>
            <input
              type="text"
              placeholder="HH:MM:SS"
              value={zone.pickupWindowEnd || ''}
              onChange={(e) => setField('pickupWindowEnd', e.target.value || undefined)}
              className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
            />
          </div>
        </div>
        <label className="block text-[10px] text-warm-gray mb-1">Service pattern</label>
        {(calendars.length > 0 || datesOnlyServiceIds.length > 0) ? (
          <>
            <select
              value={zone.serviceId || ''}
              onChange={(e) => setField('serviceId', e.target.value || undefined)}
              className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
            >
              <option value="">— Pick a service pattern —</option>
              {calendars.map((c) => {
                const exceptionCount = calendarDates.filter((d) => d.service_id === c.service_id).length;
                return (
                  <option key={c.service_id} value={c.service_id}>
                    {(c._description ? c._description + ' · ' : '') + c.service_id + ' — ' + describeServicePattern(c)}
                    {exceptionCount > 0 ? ` (+${exceptionCount} exceptions)` : ''}
                  </option>
                );
              })}
              {datesOnlyServiceIds.map((sid) => {
                const dates = calendarDates.filter((d) => d.service_id === sid);
                return (
                  <option key={sid} value={sid}>
                    {sid} — {dates.length} exception{dates.length !== 1 ? 's' : ''} only (calendar_dates)
                  </option>
                );
              })}
            </select>
            <p className="text-[10px] text-warm-gray/80 mt-1">
              The flex trip on export uses this service_id. calendar_dates exceptions apply automatically. Manage patterns in the Calendars tab.
            </p>
          </>
        ) : (
          <div className="bg-cream border border-sand rounded px-2 py-1.5 text-[11px] text-warm-gray">
            No calendars defined yet.{' '}
            <button
              type="button"
              onClick={() => setSidebarSection('calendar')}
              className="text-purple font-semibold hover:underline"
            >
              Create one →
            </button>
          </div>
        )}
      </div>

      {/* Booking */}
      <div>
        <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
          Booking
        </div>

        {/* Booking-rule library: define a call centre's rule once, attach it to
            every zone it covers. Editing it edits it everywhere — the banner
            below says how many zones that is. */}
        <label className="block text-[10px] text-warm-gray mb-0.5">Booking rule</label>
        <select
          value={ruleId ?? ''}
          onChange={(e) => pickRule(e.target.value)}
          aria-label="Booking rule"
          className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
        >
          <option value="">— No booking rule —</option>
          {library.map((r) => {
            const uses = bookingRuleZones(flexZones, r.id!).length;
            return (
              <option key={r.id} value={r.id}>
                {r.name || r.id}{uses > 1 ? ` · used by ${uses} zones` : ''}
              </option>
            );
          })}
          <option value={NEW_RULE}>+ New booking rule…</option>
        </select>

        {!rule ? (
          <p className="text-[10px] text-warm-gray/80 mt-1">
            No booking rule. Riders phoning to book need one — attach a rule another zone already uses, or create one.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-1 mt-2">
              <input
                type="text"
                value={b.name ?? ''}
                onChange={(e) => renameBookingRule(ruleId!, e.target.value)}
                placeholder="Rule name"
                aria-label="Booking rule name"
                className="flex-1 px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
              <button
                type="button"
                onClick={removeRule}
                className="px-1.5 py-1 text-[11px] text-warm-gray hover:text-red-500 rounded shrink-0"
                title="Delete this booking rule"
              >
                Delete
              </button>
            </div>
            {sharedCount > 1 && (
              <p className="text-[10px] text-purple mt-1 mb-1">
                Shared — used by {sharedCount} zones. Edits here apply to all of them.
              </p>
            )}

            <div className="flex gap-1 mt-2 mb-2">
              {BOOKING_TYPES.map((bt) => (
                <button
                  key={bt.value}
                  onClick={() => setBooking('bookingType', bt.value)}
                  title={bt.hint}
                  className={`flex-1 px-2 py-1.5 rounded text-[11px] font-semibold transition-colors
                    ${b.bookingType === bt.value
                      ? 'bg-purple text-white'
                      : 'bg-white text-warm-gray border border-sand hover:border-purple'
                    }`}
                >
                  {bt.label}
                </button>
              ))}
            </div>

            {/* Which prior_notice_* fields are legal is keyed on booking_type:
                real-time forbids all of them, same-day takes minutes of notice,
                prior-day takes a day + time cutoff. Only the permitted fields
                are rendered, so a Forbidden combination can't be typed in. */}
            {b.bookingType === 0 && (
              <p className="text-[10px] text-warm-gray/80 mb-2">
                Real-time booking takes no advance notice, so no prior-notice fields apply.
              </p>
            )}

            {b.bookingType === 1 && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className="block text-[10px] text-warm-gray mb-0.5">Min minutes ahead</label>
                  <input
                    type="number"
                    min="0"
                    value={b.priorNoticeDurationMin ?? ''}
                    onChange={(e) => setBooking('priorNoticeDurationMin',
                      e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="e.g. 60"
                    aria-label="Min minutes ahead"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-warm-gray mb-0.5">Max minutes ahead</label>
                  <input
                    type="number"
                    min="0"
                    disabled={b.priorNoticeStartDay != null}
                    value={b.priorNoticeDurationMax ?? ''}
                    onChange={(e) => setBooking('priorNoticeDurationMax',
                      e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="optional"
                    aria-label="Max minutes ahead"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple disabled:bg-cream disabled:text-warm-gray/60"
                  />
                </div>
              </div>
            )}

            {b.bookingType === 2 && (
              <>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <label className="block text-[10px] text-warm-gray mb-0.5">Days before (cutoff)</label>
                    <input
                      type="number"
                      min="0"
                      value={b.priorNoticeLastDay ?? ''}
                      onChange={(e) => setBooking('priorNoticeLastDay',
                        e.target.value === '' ? undefined : Number(e.target.value))}
                      placeholder="e.g. 1"
                      aria-label="Days before (cutoff)"
                      className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-warm-gray mb-0.5">Cutoff time</label>
                    <input
                      type="text"
                      value={b.priorNoticeLastTime ?? ''}
                      onChange={(e) => setBooking('priorNoticeLastTime', e.target.value || undefined)}
                      placeholder="17:00:00"
                      aria-label="Cutoff time"
                      className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                    />
                  </div>
                </div>
                <div className="mb-2">
                  <label className="block text-[10px] text-warm-gray mb-0.5">Prior-notice calendar</label>
                  <select
                    value={b.priorNoticeServiceId ?? ''}
                    onChange={(e) => setBooking('priorNoticeServiceId', e.target.value || undefined)}
                    aria-label="Prior-notice calendar"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                  >
                    <option value="">— Calendar days (default) —</option>
                    {calendars.map((c) => (
                      <option key={c.service_id} value={c.service_id}>
                        {(c._description ? c._description + ' · ' : '') + c.service_id} — {describeServicePattern(c)}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-warm-gray/80 mt-0.5">
                    Count the days above against this pattern's service days (e.g. a Friday cutoff for Monday service).
                  </p>
                </div>
              </>
            )}

            {/* Booking opens N days ahead. Optional on same-day and prior-day
                booking (and mutually exclusive with "max minutes ahead"); the
                time is required whenever the day is set, so it only unlocks
                once there's a day. */}
            {(b.bookingType === 1 || b.bookingType === 2) && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className="block text-[10px] text-warm-gray mb-0.5">Booking opens (days before)</label>
                  <input
                    type="number"
                    min="0"
                    disabled={b.bookingType === 1 && b.priorNoticeDurationMax != null}
                    value={b.priorNoticeStartDay ?? ''}
                    onChange={(e) => setBooking('priorNoticeStartDay',
                      e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="optional"
                    aria-label="Booking opens (days before)"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple disabled:bg-cream disabled:text-warm-gray/60"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-warm-gray mb-0.5">Opens at</label>
                  <input
                    type="text"
                    disabled={b.priorNoticeStartDay == null}
                    value={b.priorNoticeStartTime ?? ''}
                    onChange={(e) => setBooking('priorNoticeStartTime', e.target.value || undefined)}
                    placeholder="09:00:00"
                    aria-label="Booking opens at"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple disabled:bg-cream disabled:text-warm-gray/60"
                  />
                </div>
                {b.bookingType === 1 && b.priorNoticeDurationMax != null && (
                  <p className="col-span-2 text-[10px] text-warm-gray/80">
                    Clear "max minutes ahead" to set an opening day instead — same-day booking allows one or the other, not both.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div>
                <label className="block text-[10px] text-warm-gray mb-0.5">Booking phone</label>
                <input
                  type="tel"
                  value={b.phoneNumber || ''}
                  onChange={(e) => setBooking('phoneNumber', e.target.value || undefined)}
                  placeholder="e.g. (406) 555-1234"
                  aria-label="Booking phone"
                  className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                />
              </div>
              <div>
                <label className="block text-[10px] text-warm-gray mb-0.5">Booking URL</label>
                <input
                  type="url"
                  value={b.bookingUrl || ''}
                  onChange={(e) => setBooking('bookingUrl', e.target.value || undefined)}
                  placeholder="Rider-facing booking page"
                  aria-label="Booking URL"
                  className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                />
              </div>
              <div>
                <label className="block text-[10px] text-warm-gray mb-0.5">Info URL</label>
                <input
                  type="url"
                  value={b.infoUrl || ''}
                  onChange={(e) => setBooking('infoUrl', e.target.value || undefined)}
                  placeholder="Page about the service"
                  aria-label="Info URL"
                  className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                />
              </div>
              <div>
                <label className="block text-[10px] text-warm-gray mb-0.5">Rider message</label>
                <textarea
                  value={b.message || ''}
                  onChange={(e) => setBooking('message', e.target.value || undefined)}
                  placeholder="e.g. &quot;Call at least 1 hour before pickup.&quot;"
                  rows={2}
                  aria-label="Rider message"
                  className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple resize-y min-h-[3.5rem]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-warm-gray mb-0.5">Pickup message</label>
                  <textarea
                    value={b.pickupMessage || ''}
                    onChange={(e) => setBooking('pickupMessage', e.target.value || undefined)}
                    placeholder="Shown when booking a pickup"
                    rows={2}
                    aria-label="Pickup message"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple resize-y min-h-[3.5rem]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-warm-gray mb-0.5">Drop-off message</label>
                  <textarea
                    value={b.dropOffMessage || ''}
                    onChange={(e) => setBooking('dropOffMessage', e.target.value || undefined)}
                    placeholder="Shown when booking a drop-off"
                    rows={2}
                    aria-label="Drop-off message"
                    className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple resize-y min-h-[3.5rem]"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* How riders board — stop_times pickup_type / drop_off_type. Only the
            values the spec allows on a row with a pickup/drop-off window are
            offered (no pickup_type 0/3, no drop_off_type 0). */}
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Pickup</label>
            <select
              value={pickupType}
              onChange={(e) => setField('pickupType', Number(e.target.value) as FlexZone['pickupType'])}
              aria-label="Pickup type"
              className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
            >
              {PICKUP_TYPES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Drop-off</label>
            <select
              value={dropOffType}
              onChange={(e) => setField('dropOffType', Number(e.target.value) as FlexZone['dropOffType'])}
              aria-label="Drop-off type"
              className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
            >
              {DROP_OFF_TYPES.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Additional service windows */}
      <details>
        <summary className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5 cursor-pointer select-none">
          Additional Service Windows ({zone.additionalWindows?.length ?? 0})
        </summary>
        <div className="pl-2 mt-2 space-y-2">
          <p className="text-[11px] text-warm-gray/80">
            Each extra window becomes its own flex trip (e.g. morning + evening shuttles with different hours or service patterns).
          </p>
          {(zone.additionalWindows ?? []).map((w, i) => (
            <div key={i} className="bg-white border border-sand rounded p-2 space-y-1.5">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text" placeholder="Start HH:MM:SS"
                  value={w.pickupWindowStart}
                  onChange={(e) => {
                    const next = [...(zone.additionalWindows ?? [])];
                    next[i] = { ...next[i], pickupWindowStart: e.target.value };
                    setField('additionalWindows', next);
                  }}
                  className="px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                />
                <input
                  type="text" placeholder="End HH:MM:SS"
                  value={w.pickupWindowEnd}
                  onChange={(e) => {
                    const next = [...(zone.additionalWindows ?? [])];
                    next[i] = { ...next[i], pickupWindowEnd: e.target.value };
                    setField('additionalWindows', next);
                  }}
                  className="px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                />
              </div>
              <div className="flex gap-2 items-center">
                <select
                  value={w.serviceId}
                  onChange={(e) => {
                    const next = [...(zone.additionalWindows ?? [])];
                    next[i] = { ...next[i], serviceId: e.target.value };
                    setField('additionalWindows', next);
                  }}
                  className="flex-1 px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
                >
                  <option value="">— Service pattern —</option>
                  {calendars.map((c) => (
                    <option key={c.service_id} value={c.service_id}>
                      {(c._description ? c._description + ' · ' : '') + c.service_id}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const next = (zone.additionalWindows ?? []).filter((_, j) => j !== i);
                    setField('additionalWindows', next.length > 0 ? next : undefined);
                  }}
                  className="px-2 py-1 text-[11px] text-warm-gray hover:text-red-500"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              const next = [
                ...(zone.additionalWindows ?? []),
                { serviceId: zone.serviceId || calendars[0]?.service_id || '', pickupWindowStart: '', pickupWindowEnd: '' },
              ];
              setField('additionalWindows', next);
            }}
            disabled={calendars.length === 0}
            className="w-full px-2 py-1.5 border border-purple text-purple rounded text-[11px] font-semibold hover:bg-purple-50 transition-colors disabled:opacity-40"
          >
            + Add another window
          </button>
        </div>
      </details>

      {/* Travel-time estimation (advanced) */}
      <details>
        <summary className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5 cursor-pointer select-none">
          Travel-time estimation (advanced)
        </summary>
        <div className="pl-2 mt-2 space-y-1.5 text-[11px]">
          <p className="text-warm-gray/80">
            Let trip planners estimate ETA for on-demand legs. Written to trips.txt as
            safe_duration_factor / safe_duration_offset. Leave blank if unsure.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-warm-gray mb-0.5">Safe duration factor</label>
              <input
                type="number" step="0.01" min="0"
                value={zone.safeDurationFactor ?? ''}
                onChange={(e) => setField('safeDurationFactor',
                  e.target.value === '' ? undefined : Number(e.target.value))}
                placeholder="e.g. 1.5"
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
            <div>
              <label className="block text-[10px] text-warm-gray mb-0.5">Safe duration offset (s)</label>
              <input
                type="number" step="1"
                value={zone.safeDurationOffset ?? ''}
                onChange={(e) => setField('safeDurationOffset',
                  e.target.value === '' ? undefined : Number(e.target.value))}
                placeholder="e.g. 600"
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
          </div>
        </div>
      </details>

      {/* Fare assignment */}
      <div>
        <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
          Fare
        </div>
        <select
          value={zone.fareId || ''}
          onChange={(e) => setField('fareId', e.target.value || undefined)}
          className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
        >
          <option value="">— No fare assigned —</option>
          {fareAttributes.map((f) => (
            <option key={f.fare_id} value={f.fare_id}>
              {f.fare_id} — ${Number(f.price).toFixed(2)} {f.currency_type}
            </option>
          ))}
        </select>
        {fareAttributes.length === 0 && (
          <p className="text-[10px] text-warm-gray mt-1">
            Define fares in the Fares section first to assign one to this zone.
          </p>
        )}
      </div>
    </div>
  );
}
