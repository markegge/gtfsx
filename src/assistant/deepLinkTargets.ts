// Runtime whitelist of deep-link targets the assistant's open_panel tool may
// resolve to, plus a compile-time exhaustiveness check so this file can't drift
// from the SidebarSection / BottomPanelTab unions. Imported by the chat UI (to
// dispatch) and by the manifest drift test (to validate every deepLink).

import type { SidebarSection, BottomPanelTab } from '../types/ui';

export const SIDEBAR_SECTIONS = [
  'agency', 'calendar', 'routes', 'stops', 'stations', 'frequencies', 'blocks',
  'fares', 'flex', 'costs', 'coverage', 'titlevi', 'stop-analysis',
  'access-isochrones', 'alerts', 'variants', 'settings',
] as const satisfies readonly SidebarSection[];

export const BOTTOM_PANEL_TABS = [
  'timetable', 'blocks', 'service-summary', 'validation', 'snapshots', 'publish',
  'embed', 'audit',
] as const satisfies readonly BottomPanelTab[];

// Compile error if a SidebarSection / BottomPanelTab is added to the union but
// not to the arrays above (keeps the assistant's deep links exhaustive).
type _SectionExhaustive = Exclude<SidebarSection, (typeof SIDEBAR_SECTIONS)[number]> extends never
  ? true
  : ['SIDEBAR_SECTIONS missing', Exclude<SidebarSection, (typeof SIDEBAR_SECTIONS)[number]>];
type _TabExhaustive = Exclude<BottomPanelTab, (typeof BOTTOM_PANEL_TABS)[number]> extends never
  ? true
  : ['BOTTOM_PANEL_TABS missing', Exclude<BottomPanelTab, (typeof BOTTOM_PANEL_TABS)[number]>];
const _sectionCheck: _SectionExhaustive = true;
const _tabCheck: _TabExhaustive = true;
// Reference them so noUnusedLocals is satisfied; the assignments above are the
// actual compile-time exhaustiveness assertions.
void _sectionCheck;
void _tabCheck;

const SIDEBAR_SET = new Set<string>(SIDEBAR_SECTIONS);
const BOTTOM_SET = new Set<string>(BOTTOM_PANEL_TABS);

export function isSidebarSection(id: string): id is SidebarSection {
  return SIDEBAR_SET.has(id);
}
export function isBottomPanelTab(id: string): id is BottomPanelTab {
  return BOTTOM_SET.has(id);
}

// A deep-link target is any valid sidebar section or bottom-panel tab id.
export function isDeepLinkTarget(id: string): boolean {
  return isSidebarSection(id) || isBottomPanelTab(id);
}
