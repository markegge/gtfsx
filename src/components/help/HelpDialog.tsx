interface HelpDialogProps {
  onClose: () => void;
}

export function HelpDialog({ onClose }: HelpDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-sand shrink-0">
          <h2 className="font-heading font-bold text-lg text-dark-brown">Getting Started</h2>
          <button onClick={onClose} className="text-warm-gray hover:text-dark-brown text-xl">×</button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto px-6 py-4 text-sm text-dark-brown leading-relaxed">
          <Section title="1. Set up your agency">
            Click <B>Agency</B> in the sidebar. Enter your agency name, URL, and timezone.
            This information identifies who operates the transit service.
          </Section>

          <Section title="2. Define service calendars">
            Click <B>Calendars</B>. Create service patterns (e.g., Weekdays, Weekends) by
            toggling which days of the week service runs. Set the date range and add
            holiday exceptions. Use <B>Add US Holidays</B> to quickly add federal holidays.
          </Section>

          <Section title="3. Draw your routes">
            Click <B>Routes</B>, then <B>Create Route</B>. Give it a name, pick a color,
            and click <B>Draw Route Shape</B>. Click on the map to place points along the
            route, then <B>double-click</B> to finish.
            <ul className="mt-1.5 ml-4 list-disc text-warm-gray space-y-1">
              <li><B>Snap to road</B> (on by default) snaps your line to the road network</li>
              <li>Use the <B>direction picker</B> to draw separate outbound/inbound shapes</li>
              <li><B>Edit Vertices</B> to drag, add, or delete points on an existing shape</li>
              <li><B>Simplify</B> reduces vertex count if a shape has too many points</li>
            </ul>
          </Section>

          <Section title="4. Add stops">
            Select a route and click <B>Add Stops to Route</B>, or go to <B>Stops</B>.
            Choose a route from the dropdown, then click <B>Place Stops on Map</B>.
            <ul className="mt-1.5 ml-4 list-disc text-warm-gray space-y-1">
              <li><B>Snap to Route</B> (default) places stops on the route line</li>
              <li><B>Freehand</B> lets you place stops anywhere</li>
              <li>Click each stop in the sidebar to edit its name and properties</li>
            </ul>
          </Section>

          <Section title="5. Build timetables">
            Click <B>Timetables</B> and select a route. The bottom panel shows a grid
            of trips (rows) and stops (columns). Enter departure times in each cell.
            <ul className="mt-1.5 ml-4 list-disc text-warm-gray space-y-1">
              <li>Type times as <code className="px-1 bg-sand rounded text-xs">7:30</code> or <code className="px-1 bg-sand rounded text-xs">730</code> — they auto-format</li>
              <li><B>+ Add Trip</B> creates a new row</li>
              <li><B>Repeat Every...</B> duplicates the last trip at a fixed headway</li>
              <li>The <B>interpolate</B> button (arrow icon) fills intermediate stop times from the first and last</li>
              <li>Use the <B>Outbound/Inbound</B> toggle to switch directions</li>
            </ul>
          </Section>

          <Section title="6. Set fares (recommended)">
            Click <B>Fares</B> to define ticket prices. Add a fare with a price and
            associate it with your routes. Trip planning apps need this data.
          </Section>

          <Section title="7. Validate and export">
            Click <B>Export GTFS</B> in the top bar. The app validates your feed and
            shows any errors or warnings. Fix errors (click them to navigate to the
            issue), then export as a ZIP file.
          </Section>

          <div className="border-t border-sand pt-4 mt-2">
            <h3 className="font-heading font-bold text-sm text-dark-brown mb-2">Analysis Tools</h3>
            <p className="text-warm-gray mb-2">
              <B>Costs</B> — Set a cost per revenue hour and deadhead factor to estimate
              daily and annual operating costs per route and system-wide.
            </p>
            <p className="text-warm-gray mb-2">
              <B>Coverage</B> — Analyze population, households, and jobs within walking
              distance of your stops using Census data.
            </p>
          </div>

          <div className="border-t border-sand pt-4 mt-2">
            <h3 className="font-heading font-bold text-sm text-dark-brown mb-2">Keyboard Shortcuts</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-warm-gray">
              <span><Key>Esc</Key> Cancel drawing / discard edits</span>
              <span><Key>Delete</Key> Remove selected vertex</span>
              <span><Key>Tab</Key> Next timetable cell</span>
              <span><Key>Shift+Tab</Key> Previous cell</span>
            </div>
          </div>

          <div className="border-t border-sand pt-4 mt-2">
            <h3 className="font-heading font-bold text-sm text-dark-brown mb-2">Tips</h3>
            <ul className="list-disc ml-4 text-warm-gray space-y-1">
              <li>Click any route or stop on the map to see details and quick-edit</li>
              <li>Direction arrows on routes show the direction of travel</li>
              <li>Import an existing GTFS ZIP to edit a feed you already have</li>
              <li>Your work auto-saves to the browser — refresh won't lose data</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">{title}</h3>
      <p className="text-warm-gray">{children}</p>
    </div>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return <strong className="text-dark-brown font-semibold">{children}</strong>;
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 bg-sand rounded text-[10px] font-mono text-dark-brown mr-1">
      {children}
    </kbd>
  );
}
