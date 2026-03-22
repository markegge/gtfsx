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
  ProjectSlice;

export const useStore = create<AppStore>()(
  immer((...args) => ({
    ...createAgencySlice(...args),
    ...createCalendarSlice(...args),
    ...createRouteSlice(...args),
    ...createStopSlice(...args),
    ...createTripSlice(...args),
    ...createShapeSlice(...args),
    ...createFareSlice(...args),
    ...createFeedInfoSlice(...args),
    ...createValidationSlice(...args),
    ...createUISlice(...args),
    ...createProjectSlice(...args),
  }))
);
