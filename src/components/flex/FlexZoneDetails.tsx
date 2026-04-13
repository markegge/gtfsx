import { useStore } from '../../store';
import type { FlexZone, BookingRule } from '../../store/flexSlice';

interface Props {
  zone: FlexZone;
}

const BOOKING_TYPES: { value: 0 | 1 | 2; label: string; hint: string }[] = [
  { value: 0, label: 'Real-time', hint: 'No advance notice required' },
  { value: 1, label: 'Same-day', hint: 'Minimum minutes of notice' },
  { value: 2, label: 'Prior day', hint: 'Booking closes day(s) before service' },
];

export function FlexZoneDetails({ zone }: Props) {
  const { updateFlexZone, updateFlexZoneBooking, fareAttributes } = useStore();
  const b: Partial<BookingRule> = zone.bookingRule ?? { bookingType: 1 };

  const setField = <K extends keyof FlexZone>(k: K, v: FlexZone[K]) =>
    updateFlexZone(zone.id, { [k]: v } as Partial<FlexZone>);

  const setBooking = <K extends keyof BookingRule>(k: K, v: BookingRule[K]) =>
    updateFlexZoneBooking(zone.id, { [k]: v });

  return (
    <div className="px-3 pb-3 pt-1 space-y-3 bg-purple-50/30 border-l-2 border-purple-200">
      {/* Service window */}
      <div>
        <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
          Service Window
        </div>
        <div className="grid grid-cols-2 gap-2">
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
            className="w-full px-2 py-1 border border-sand rounded text-xs bg-white focus:outline-none focus:border-purple resize-none"
          />
        </div>
      </div>

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
