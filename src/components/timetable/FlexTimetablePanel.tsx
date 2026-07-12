import { useStore } from '../../store';
import { openFlexZoneDetails } from '../flex/flexHelpers';
import { Badge } from '../ui/Badge';
import { formatTimeShort } from '../../utils/time';
import type { BookingRule, FlexZone } from '../../store/flexSlice';
import type { Route } from '../../types/gtfs';

interface Props {
  route: Route;
  zone?: FlexZone;
}

const BOOKING_TYPE_LABELS: Record<0 | 1 | 2, string> = {
  0: 'Real-time — no advance notice required',
  1: 'Same-day — advance notice required',
  2: 'Prior day — booking closes before the service day',
};

function formatWindow(start?: string, end?: string): string | null {
  if (!start && !end) return null;
  const from = start ? formatTimeShort(start) : '—';
  const to = end ? formatTimeShort(end) : '—';
  return `${from} – ${to}`;
}

function describeNotice(b: BookingRule): string | null {
  if (b.bookingType === 1) {
    if (b.priorNoticeDurationMin === undefined) return null;
    const max = b.priorNoticeDurationMax;
    return max !== undefined
      ? `${b.priorNoticeDurationMin}–${max} min of notice`
      : `${b.priorNoticeDurationMin} min of notice`;
  }
  if (b.bookingType === 2) {
    if (b.priorNoticeLastDay === undefined) return null;
    const days = `${b.priorNoticeLastDay} day${b.priorNoticeLastDay === 1 ? '' : 's'} before`;
    return b.priorNoticeLastTime
      ? `Book by ${formatTimeShort(b.priorNoticeLastTime)}, ${days}`
      : `Book ${days}`;
  }
  return null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 border-b border-sand last:border-b-0">
      <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-0.5">
        {label}
      </div>
      <div className="text-xs text-dark-brown">{children}</div>
    </div>
  );
}

export function FlexTimetablePanel({ route, zone }: Props) {
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);
  const setSidebarSection = useStore((s) => s.setSidebarSection);

  const serviceLabel = (serviceId?: string): string => {
    if (!serviceId) return 'Not set';
    const cal = calendars.find((c) => c.service_id === serviceId);
    if (cal) return cal._description ? `${cal._description} · ${serviceId}` : serviceId;
    if (calendarDates.some((d) => d.service_id === serviceId)) {
      return `${serviceId} (calendar_dates only)`;
    }
    return serviceId;
  };

  const primaryWindow = zone ? formatWindow(zone.pickupWindowStart, zone.pickupWindowEnd) : null;
  const extraWindows = zone?.additionalWindows ?? [];
  const booking = zone?.bookingRule;
  const notice = booking ? describeNotice(booking) : null;
  const bookingMessage = booking?.message || booking?.pickupMessage || booking?.dropOffMessage;
  const routeName = route.route_short_name || route.route_long_name || route.route_id;

  return (
    <div className="overflow-auto flex-1 min-h-0 px-2 pb-3">
      <div className="max-w-2xl mx-auto mt-2 bg-cream border border-sand rounded-lg overflow-hidden">
        <div className="px-3 py-2.5 bg-purple-light/60 border-b border-sand">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="info">Demand response</Badge>
            <span className="font-heading font-bold text-sm text-dark-brown">
              {zone?.name?.trim() || routeName}
            </span>
          </div>
          <p className="text-xs text-warm-gray mt-1.5">
            This is a demand-response (GTFS-Flex) route. Its schedule is a pickup / drop-off window
            over a service area, not a sequence of stop times, so it has no timetable by design.
            Its flex trip is generated when you export the feed.
          </p>
        </div>

        {zone ? (
          <>
            <Field label="Service window">
              {primaryWindow ? (
                <span className="font-semibold">{primaryWindow}</span>
              ) : (
                <span className="text-warm-gray">
                  No window set — the zone runs whenever its service pattern is active.
                </span>
              )}
            </Field>

            {extraWindows.length > 0 && (
              <Field label={`Additional windows · ${extraWindows.length}`}>
                <ul className="space-y-0.5">
                  {extraWindows.map((w, i) => (
                    <li key={`${w.serviceId}-${w.pickupWindowStart}-${i}`}>
                      <span className="font-semibold">
                        {formatWindow(w.pickupWindowStart, w.pickupWindowEnd)}
                      </span>
                      <span className="text-warm-gray"> · {serviceLabel(w.serviceId)}</span>
                    </li>
                  ))}
                </ul>
              </Field>
            )}

            <Field label="Service pattern">
              {zone.serviceId ? (
                serviceLabel(zone.serviceId)
              ) : (
                <span className="text-warm-gray">
                  Not set — pick one in the Flex Zones panel so the zone exports.
                </span>
              )}
            </Field>

            <Field label="Booking">
              {booking ? (
                <div className="space-y-0.5">
                  <div className="font-semibold">{BOOKING_TYPE_LABELS[booking.bookingType]}</div>
                  {notice && <div className="text-warm-gray">{notice}</div>}
                  {booking.phoneNumber && <div>Phone: {booking.phoneNumber}</div>}
                  {(booking.bookingUrl || booking.infoUrl) && (
                    <div className="truncate">
                      Online:{' '}
                      <a
                        href={booking.bookingUrl || booking.infoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-purple font-semibold hover:underline"
                      >
                        {booking.bookingUrl || booking.infoUrl}
                      </a>
                    </div>
                  )}
                  {bookingMessage && <div className="text-warm-gray italic">“{bookingMessage}”</div>}
                </div>
              ) : (
                <span className="text-warm-gray">
                  No booking rule — riders get no booking instructions in trip planners.
                </span>
              )}
            </Field>
          </>
        ) : (
          <Field label="Service area">
            <span className="text-warm-gray">
              No flex zone is linked to this route yet. Draw one in the Flex Zones panel to give it a
              service area and a pickup window.
            </span>
          </Field>
        )}

        <div className="px-3 py-2.5 border-t border-sand">
          <button
            onClick={() => (zone ? openFlexZoneDetails(zone.id) : setSidebarSection('flex'))}
            className="px-3 py-1.5 bg-purple text-white rounded-md text-xs font-bold hover:opacity-90 transition-opacity"
          >
            {zone ? 'Edit zone in Flex Zones →' : 'Open Flex Zones →'}
          </button>
        </div>
      </div>
    </div>
  );
}
