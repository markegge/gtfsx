import { TimetableGrid } from './TimetableGrid';

/**
 * Center-pane host for the timetable builder (centerView === 'timetable').
 *
 * Thin by design: the TimetableGrid already carries its own route / service /
 * pattern selectors, toolbar, and the "Generate service" empty-state (B1), so
 * this wrapper just gives it a full-bleed white surface in the map's pane. The
 * Map ⇄ Timetable ⇄ Blocks switcher lives in the shared bar atop the pane
 * (AppShell), not here.
 */
export function TimetableView() {
  return (
    <div className="absolute inset-0 bg-white flex flex-col min-h-0">
      <TimetableGrid />
    </div>
  );
}
