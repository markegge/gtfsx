import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createAgencySlice, type AgencySlice } from './agencySlice';
import { createCalendarSlice, type CalendarSlice } from './calendarSlice';
import { createRouteSlice, type RouteSlice } from './routeSlice';
import { createStopSlice, type StopSlice } from './stopSlice';
import { createTripSlice, type TripSlice } from './tripSlice';
import { createShapeSlice, type ShapeSlice } from './shapeSlice';
import { createFareSlice, type FareSlice } from './fareSlice';
import { createFeedInfoSlice, type FeedInfoSlice } from './feedInfoSlice';
import { createValidationSlice, type ValidationSlice } from './validationSlice';
import { createUISlice, type UISlice } from './uiSlice';
import { createProjectSlice, type ProjectSlice } from './projectSlice';
import { createCoverageSlice, type CoverageSlice } from './coverageSlice';

export type AppStore = AgencySlice &
  CalendarSlice &
  RouteSlice &
  StopSlice &
  TripSlice &
  ShapeSlice &
  FareSlice &
  FeedInfoSlice &
  ValidationSlice &
  UISlice &
  ProjectSlice &
  CoverageSlice;

export const useStore = create<AppStore>()(
  immer((...a) => ({
    ...(createAgencySlice as any)(...a),
    ...(createCalendarSlice as any)(...a),
    ...(createRouteSlice as any)(...a),
    ...(createStopSlice as any)(...a),
    ...(createTripSlice as any)(...a),
    ...(createShapeSlice as any)(...a),
    ...(createFareSlice as any)(...a),
    ...(createFeedInfoSlice as any)(...a),
    ...(createValidationSlice as any)(...a),
    ...(createUISlice as any)(...a),
    ...(createProjectSlice as any)(...a),
    ...(createCoverageSlice as any)(...a),
  }))
);

// Expose store and test runner for testing/debugging
if (typeof window !== 'undefined') {
  (window as any).__gtfsStore = useStore;

  // Lazy-load test runner
  (window as any).__runTests = async (zipPath?: string) => {
    const { runAllTests } = await import('../tests/feedTests');
    const path = zipPath || '/pittsburgh_gtfs.zip';
    console.log(`Fetching ${path}...`);
    const resp = await fetch(path);
    const blob = await resp.blob();
    const file = new File([blob], 'pittsburgh_gtfs.zip', { type: 'application/zip' });
    return runAllTests(file);
  };
}
