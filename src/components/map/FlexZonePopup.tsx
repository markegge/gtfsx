import { Popup } from 'react-map-gl/mapbox';
import { useStore } from '../../store';

interface Props {
  zoneId: string;
  lngLat: { lng: number; lat: number };
  onClose: () => void;
}

const BOOKING_LABEL: Record<0 | 1 | 2, string> = {
  0: 'Real-time',
  1: 'Same-day',
  2: 'Prior day',
};

function formatTimeShort(hhmmss?: string): string {
  if (!hhmmss) return '';
  const [hStr, m] = hhmmss.split(':');
  const h = Number(hStr);
  if (Number.isNaN(h)) return hhmmss;
  const hour12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 || h >= 24 ? 'am' : 'pm';
  return m && m !== '00' ? `${hour12}:${m}${ampm}` : `${hour12}${ampm}`;
}

export function FlexZonePopup({ zoneId, lngLat, onClose }: Props) {
  const zone = useStore((s) => s.flexZones.find((z) => z.id === zoneId));
  const route = useStore((s) =>
    zone?.routeId ? s.routes.find((r) => r.route_id === zone.routeId) : undefined
  );
  const calendar = useStore((s) =>
    zone?.serviceId ? s.calendars.find((c) => c.service_id === zone.serviceId) : undefined
  );
  const fare = useStore((s) =>
    zone?.fareId ? s.fareAttributes.find((f) => f.fare_id === zone.fareId) : undefined
  );
  const { selectRoute, setEditingRouteId, setSidebarSection } = useStore();

  if (!zone) return null;

  const b = zone.bookingRule;
  const color = route?.route_color ? `#${route.route_color}` : '#7C3AED';

  const dayPattern = calendar
    ? (() => {
        const flags = [
          calendar.monday, calendar.tuesday, calendar.wednesday,
          calendar.thursday, calendar.friday, calendar.saturday, calendar.sunday,
        ];
        const names = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'];
        const on = flags.reduce<string[]>((acc, v, i) => (v ? [...acc, names[i]] : acc), []);
        if (on.length === 7) return 'Every day';
        if (flags.join('') === '1111100') return 'Weekdays';
        if (flags.join('') === '0000011') return 'Weekends';
        return on.join(' ');
      })()
    : null;

  const editRoute = () => {
    if (!zone.routeId) return;
    selectRoute(zone.routeId);
    setEditingRouteId(zone.routeId);
    setSidebarSection('routes');
    onClose();
  };

  const editDetails = () => {
    setSidebarSection('flex');
    // Signal the Flex sidebar to open this specific zone's Details panel.
    window.__flexZoneExpand = zone.id;
    onClose();
  };

  return (
    <Popup
      longitude={lngLat.lng}
      latitude={lngLat.lat}
      anchor="bottom"
      closeOnClick={false}
      onClose={onClose}
      className="flex-zone-popup"
      maxWidth="300px"
    >
      <div style={{ padding: '4px 2px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{
            width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0,
          }} />
          <strong style={{ fontSize: 13, color: '#2A1F18' }}>{zone.name}</strong>
        </div>

        <div style={{ fontSize: 11, color: '#6B5A4D', lineHeight: 1.5, marginBottom: 8 }}>
          {zone.pickupWindowStart && zone.pickupWindowEnd && (
            <div>🕐 {formatTimeShort(zone.pickupWindowStart)}–{formatTimeShort(zone.pickupWindowEnd)}</div>
          )}
          {dayPattern && <div>📅 {dayPattern}</div>}
          {b && (
            <div>
              📞 {BOOKING_LABEL[b.bookingType]}
              {b.bookingType === 1 && b.priorNoticeDurationMin != null && ` · ${b.priorNoticeDurationMin}+ min ahead`}
              {b.bookingType === 2 && b.priorNoticeLastDay != null && ` · ${b.priorNoticeLastDay}d ahead`}
              {b.phoneNumber && ` · ${b.phoneNumber}`}
            </div>
          )}
          {fare && (
            <div>
              💲 ${Number(fare.price).toFixed(2)} {fare.currency_type}
              {` (${fare.payment_method === 0 ? 'Pay on board' : 'Pay before boarding'})`}
            </div>
          )}
          {!zone.pickupWindowStart && !dayPattern && !b && !fare && (
            <div style={{ fontStyle: 'italic', color: '#9CA3AF' }}>
              No service details yet. Open Edit Service Details to configure.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {zone.routeId && (
            <button
              onClick={editRoute}
              style={{
                flex: 1, padding: '5px 10px', fontSize: 11, fontWeight: 600,
                border: '1px solid #E5D6BE', borderRadius: 6,
                background: '#FFF', color: '#2A1F18', cursor: 'pointer',
              }}
            >
              Edit Route
            </button>
          )}
          <button
            onClick={editDetails}
            style={{
              flex: 1, padding: '5px 10px', fontSize: 11, fontWeight: 600,
              border: 0, borderRadius: 6,
              background: '#7C3AED', color: '#FFF', cursor: 'pointer',
            }}
          >
            Edit Service Details
          </button>
        </div>
      </div>
    </Popup>
  );
}
