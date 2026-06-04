import { useStore } from '../../store';
import type { FlexZone, BookingRule } from '../../store/flexSlice';
import { flexZoneHasGroup, flexZoneHasPolygons } from '../../store/flexSlice';

interface Props {
  zone: FlexZone;
}

const BOOKING_TYPES: { value: 0 | 1 | 2; label: string; hint: string }[] = [
  { value: 0, label: 'Real-time', hint: 'No advance notice required' },
  { value: 1, label: 'Same-day', hint: 'Minimum minutes of notice' },
  { value: 2, label: 'Prior day', hint: 'Booking closes day(s) before service' },
];

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
    stops, setSidebarSection,
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
  const b: Partial<BookingRule> = zone.bookingRule ?? { bookingType: 1 };

  const setField = <K extends keyof FlexZone>(k: K, v: FlexZone[K]) =>
    updateFlexZone(zone.id, { [k]: v } as Partial<FlexZone>);

  const setBooking = <K extends keyof BookingRule>(k: K, v: BookingRule[K]) =>
    updateFlexZoneBooking(zone.id, { [k]: v });

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
                <button
                  type="button"
                  onClick={() => clearFlexZonePolygons(zone.id)}
                  className="px-1.5 py-0.5 text-[11px] text-warm-gray hover:text-red-500 rounded"
                  title="Remove all polygon geometry"
                  disabled={!hasGroup}
                >
                  Remove
                </button>
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
            <p className="text-[10px] text-warm-gray/80 mt-1">
              Exported to <code>locations.geojson</code>. Edit shape on the map via "Edit Shape".
            </p>
          ) : (
            <p className="text-[10px] text-warm-gray/80 mt-1">
              No polygon yet. Add one to cover an on-demand area.
            </p>
          )}
          {hasPolygons && !hasGroup && (
            <p className="text-[10px] text-warm-gray/60 mt-0.5">
              Add a stop group below to make this a mixed zone.
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
              <button
                type="button"
                onClick={() => removeFlexZoneGroup(zone.id)}
                className="px-1.5 py-0.5 text-[11px] text-warm-gray hover:text-red-500 rounded shrink-0"
                title="Remove the stop group from this zone"
                disabled={!hasPolygons}
              >
                Remove
              </button>
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

      {/* Booking type */}
      <div>
        <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
          Booking
        </div>
        <div className="flex gap-1 mb-2">
          {BOOKING_TYPES.map((bt) => (
            <button
              key={bt.value}
              onClick={() => setBooking('bookingType', bt.value)}
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
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
            <div>
              <label className="block text-[10px] text-warm-gray mb-0.5">Max minutes ahead</label>
              <input
                type="number"
                min="0"
                value={b.priorNoticeDurationMax ?? ''}
                onChange={(e) => setBooking('priorNoticeDurationMax',
                  e.target.value === '' ? undefined : Number(e.target.value))}
                placeholder="optional"
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
          </div>
        )}

        {b.bookingType === 2 && (
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
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <input
            type="tel"
            value={b.phoneNumber || ''}
            onChange={(e) => setBooking('phoneNumber', e.target.value || undefined)}
            placeholder="Booking phone (e.g. (406) 555-1234)"
            className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
          />
          <input
            type="url"
            value={b.bookingUrl || ''}
            onChange={(e) => setBooking('bookingUrl', e.target.value || undefined)}
            placeholder="Booking URL (rider-facing booking page)"
            className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
          />
          <input
            type="url"
            value={b.infoUrl || ''}
            onChange={(e) => setBooking('infoUrl', e.target.value || undefined)}
            placeholder="Info URL (about the service)"
            className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
          />
          <textarea
            value={b.message || ''}
            onChange={(e) => setBooking('message', e.target.value || undefined)}
            placeholder="Rider message (e.g. &quot;Call at least 1 hour before pickup.&quot;)"
            rows={2}
            className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple resize-y min-h-[3.5rem]"
          />
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
            Let trip planners estimate ETA for on-demand legs. Leave blank if unsure.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-warm-gray mb-0.5">Mean duration factor</label>
              <input
                type="number" step="0.01" min="0"
                value={zone.meanDurationFactor ?? ''}
                onChange={(e) => setField('meanDurationFactor',
                  e.target.value === '' ? undefined : Number(e.target.value))}
                placeholder="e.g. 1.0"
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
            <div>
              <label className="block text-[10px] text-warm-gray mb-0.5">Mean duration offset (s)</label>
              <input
                type="number" step="1"
                value={zone.meanDurationOffset ?? ''}
                onChange={(e) => setField('meanDurationOffset',
                  e.target.value === '' ? undefined : Number(e.target.value))}
                placeholder="e.g. 300"
                className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple"
              />
            </div>
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
