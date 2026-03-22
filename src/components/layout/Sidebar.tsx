import React from 'react';
import { useStore } from '../../store';
import { SidebarNav } from './SidebarNav';
import { AgencyEditor } from '../agency/AgencyEditor';
import { CalendarEditor } from '../calendar/CalendarEditor';
import { RouteList } from '../routes/RouteList';
import { StopList } from '../stops/StopList';
import { FaresEditor } from '../fares/FaresEditor';
import { TimetableSidebar } from '../timetable/TimetableSidebar';

export function Sidebar() {
  const section = useStore((s) => s.sidebarSection);

  return (
    <div className="w-[300px] bg-white border-r border-sand flex flex-col overflow-hidden shrink-0">
      <SidebarNav />
      <div className="h-px bg-sand mx-3" />
      <div className="flex-1 overflow-y-auto p-3">
        {section === 'agency' && <AgencyEditor />}
        {section === 'calendar' && <CalendarEditor />}
        {section === 'routes' && <RouteList />}
        {section === 'stops' && <StopList />}
        {section === 'fares' && <FaresEditor />}
        {section === 'timetable' && <TimetableSidebar />}
      </div>
    </div>
  );
}
