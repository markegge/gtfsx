import { EmptyState } from '../ui/EmptyState';

export function FlexEditor() {
  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-3">GTFS-Flex</h3>
      <p className="text-xs text-warm-gray mb-4">
        Define demand-responsive transit zones, booking rules, and flexible pickup/drop-off services.
      </p>

      <EmptyState
        icon="📍"
        title="Coming soon"
        description="GTFS-Flex support for demand-responsive zones, booking rules, and flexible services is in development."
      />

      <div className="mt-4 border-t border-sand pt-4">
        <h4 className="font-heading font-bold text-sm text-dark-brown mb-2">What is GTFS-Flex?</h4>
        <div className="text-xs text-warm-gray space-y-2">
          <p>
            GTFS-Flex extends the standard GTFS format to describe demand-responsive
            transportation services like dial-a-ride, microtransit, and deviated fixed routes.
          </p>
          <div>
            <p className="font-semibold text-brown mb-1">Planned features:</p>
            <ul className="list-disc ml-4 space-y-1">
              <li><strong className="text-dark-brown">Service zones</strong> — Draw polygon areas on the map for demand-responsive pickup/drop-off</li>
              <li><strong className="text-dark-brown">Booking rules</strong> — Define advance notice, booking methods (phone, app, URL), and confirmation</li>
              <li><strong className="text-dark-brown">Pickup/drop-off windows</strong> — Set time windows instead of fixed schedules</li>
              <li><strong className="text-dark-brown">Deviated fixed route</strong> — Mix fixed-route stops with flexible zone service</li>
              <li><strong className="text-dark-brown">Export</strong> — Generate <code className="px-1 bg-sand rounded">locations.geojson</code> and <code className="px-1 bg-sand rounded">booking_rules.txt</code></li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
