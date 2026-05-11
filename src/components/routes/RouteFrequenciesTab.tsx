export function RouteFrequenciesTab() {
  return (
    <div className="rounded-lg bg-cream p-5 text-sm text-warm-gray">
      <p className="font-semibold text-dark-brown mb-1">Frequencies are not yet supported</p>
      <p>
        This feed editor currently uses explicit stop_times trips for all service. Headway-based
        (frequencies.txt) service is on the roadmap; for now, define each trip's schedule directly
        in the timetable.
      </p>
    </div>
  );
}
