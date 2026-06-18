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
import { createFlexSlice, type FlexSlice } from './flexSlice';
import { createAuthSlice, type AuthSlice } from './authSlice';
import { createFeedsSlice, type FeedsSlice } from './feedsSlice';
import { createOrgsSlice, type OrgsSlice } from './orgsSlice';
import { createTransferSlice, type TransferSlice } from './transferSlice';
import { createFrequenciesSlice, type FrequenciesSlice } from './frequenciesSlice';
import { createLevelsSlice, type LevelsSlice } from './levelsSlice';
import { createPathwaysSlice, type PathwaysSlice } from './pathwaysSlice';
import { createFareV2Slice, type FareV2Slice } from './fareV2Slice';
import { createFeaturesSlice, type FeaturesSlice } from './featuresSlice';
import { createVariantSlice, type VariantSlice } from './variantSlice';

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
  CoverageSlice &
  FlexSlice &
  AuthSlice &
  FeedsSlice &
  OrgsSlice &
  TransferSlice &
  FrequenciesSlice &
  LevelsSlice &
  PathwaysSlice &
  FareV2Slice &
  FeaturesSlice &
  VariantSlice;

// Zustand-immer slice composition: each create*Slice is typed against its
// own slice (e.g. `StateCreator<AgencySlice, ..., [], AgencySlice>`), but
// here we hand it the immer-middleware-wrapped setter for the full AppStore.
// The mismatch is intentional — slices only touch their own keys, but the
// types don't let us express that without a full mutator-type cascade.
// Casting through `any` is the canonical Zustand-with-slices workaround.
/* eslint-disable @typescript-eslint/no-explicit-any */
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
    ...(createFlexSlice as any)(...a),
    ...(createAuthSlice as any)(...a),
    ...(createFeedsSlice as any)(...a),
    ...(createOrgsSlice as any)(...a),
    ...(createTransferSlice as any)(...a),
    ...(createFrequenciesSlice as any)(...a),
    ...(createLevelsSlice as any)(...a),
    ...(createPathwaysSlice as any)(...a),
    ...(createFareV2Slice as any)(...a),
    ...(createFeaturesSlice as any)(...a),
    ...(createVariantSlice as any)(...a),
  }))
);
/* eslint-enable @typescript-eslint/no-explicit-any */

// Expose store and test runner for testing/debugging
if (typeof window !== 'undefined') {
  window.__gtfsStore = useStore;

  // Lazy-load test runner
  window.__runTests = async (zipPath?: string) => {
    const { runAllTests } = await import('../tests/feedTests');
    const path = zipPath || '/pittsburgh_gtfs.zip';
    console.log(`Fetching ${path}...`);
    const resp = await fetch(path);
    const blob = await resp.blob();
    const file = new File([blob], 'pittsburgh_gtfs.zip', { type: 'application/zip' });
    return runAllTests(file);
  };
}
