import type { StateCreator } from 'zustand';
import type { AppStore } from './index';
import type { SidebarSection } from '../types/ui';

// Advanced/optional GTFS features that clutter the editor for simple agencies.
// Each is gated by a per-feed setting so the default UI stays lean. A feature
// is "enabled" when the feed already contains its data/file OR the user turns
// it on; `demandResponse` is the exception — on by default to push GTFS-Flex
// adoption. See featureEnabled() below.
export type AdvancedFeature =
  | 'transfers'
  | 'frequencies'
  | 'stations'
  | 'blocks'
  | 'demandResponse'
  | 'serviceAlerts'
  | 'faresV2';

export interface FeaturesSlice {
  // The user's explicit per-feature choice. Absent → use the default rule.
  // Persisted with the feed's working snapshot (IndexedDB + server R2), NOT
  // exported to the GTFS zip. For file-backed features this mirrors "the file
  // is present in the feed".
  featureSettings: Partial<Record<AdvancedFeature, boolean>>;
  setFeatureSetting: (feature: AdvancedFeature, enabled: boolean) => void;
  setFeatureSettings: (settings: Partial<Record<AdvancedFeature, boolean>>) => void;
}

export const createFeaturesSlice: StateCreator<
  FeaturesSlice,
  [['zustand/immer', never]],
  [],
  FeaturesSlice
> = (set) => ({
  featureSettings: {},
  setFeatureSetting: (feature, enabled) =>
    set((state) => {
      state.featureSettings[feature] = enabled;
    }),
  setFeatureSettings: (settings) =>
    set((state) => {
      state.featureSettings = settings ?? {};
    }),
});

export interface FeatureMeta {
  key: AdvancedFeature;
  label: string;
  /** Short, agency-facing explanation shown in the Settings panel. */
  description: string;
  /** On by default? Only demandResponse is. */
  defaultOn: boolean;
  /** Left-rail section this feature reveals, if any. (`transfers` is a tab
   *  inside the Fares panel, so it has no standalone section.) */
  section?: SidebarSection;
  /** GTFS files this feature maps to, for reference. Empty for `blocks`
   *  (a trips.txt column) and `demandResponse` (a flag). The exporter is
   *  data-driven: enabling a feature never emits an empty file — a file
   *  appears in the export only once it has rows. */
  files: string[];
  /** When the feed already contains this feature's data but the user hasn't set
   *  a preference, should the feature auto-show? True for most; false for
   *  `blocks` — block_id is too niche to surface a nav section just because a
   *  feed happens to carry it. */
  autoShowOnData?: boolean;
  /** Dynamic default (no explicit user choice): computed from store state.
   *  Used by `serviceAlerts`, which defaults on once the feed is published.
   *  Takes precedence over `defaultOn`/`autoShowOnData`. */
  defaultEnabled?: (s: AppStore) => boolean;
}

export const ADVANCED_FEATURES: FeatureMeta[] = [
  {
    key: 'demandResponse',
    label: 'Demand response / paratransit',
    description:
      'GTFS-Flex zones and booking rules for dial-a-ride, microtransit, and deviated service. On by default — turn it off if you only run fixed-route service.',
    defaultOn: true,
    section: 'flex',
    files: ['locations.geojson', 'booking_rules.txt', 'location_groups.txt', 'location_group_stops.txt'],
  },
  {
    key: 'transfers',
    label: 'Transfers',
    description:
      'transfers.txt — transfer rules between routes/stops (timed connections, minimum transfer times). Edited from the Fares panel.',
    defaultOn: false,
    files: ['transfers.txt'],
  },
  {
    key: 'frequencies',
    label: 'Frequency-based service',
    description:
      'frequencies.txt — headway-based service ("a bus every 15 min") instead of explicit per-trip times.',
    defaultOn: false,
    section: 'frequencies',
    files: ['frequencies.txt'],
  },
  {
    key: 'blocks',
    label: 'Blocks',
    description:
      'block_id on trips — groups trips a single vehicle runs in sequence (interlining). Useful for vehicle/operator scheduling.',
    defaultOn: false,
    section: 'blocks',
    files: [],
    // Niche: stay hidden even when the feed carries block_id, until opted in.
    autoShowOnData: false,
  },
  {
    key: 'stations',
    label: 'Stations & pathways',
    description:
      'levels.txt and pathways.txt — multi-level stations with walkways, stairs, and elevators between platforms.',
    defaultOn: false,
    section: 'stations',
    files: ['levels.txt', 'pathways.txt'],
  },
  {
    key: 'serviceAlerts',
    label: 'Service Alerts',
    description:
      'GTFS-Realtime service alerts — detours, delays, stop closures — published to a live feed without republishing the schedule. On by default once the feed is published.',
    defaultOn: false,
    // On by default once the feed is published; off otherwise.
    defaultEnabled: (s) => s.currentPublication != null,
    section: 'alerts',
    files: [],
    autoShowOnData: false,
  },
  {
    key: 'faresV2',
    label: 'Fares v2',
    description:
      'GTFS-Fares v2 — areas, networks, rider categories, fare products, and leg/transfer rules. The modern, more expressive fare model that consumers prefer over fare_attributes/fare_rules. Off by default; turning it on reveals the v2 authoring tabs in the Fares panel. Auto-on when the imported feed already carries v2 files.',
    defaultOn: false,
    // No standalone nav section — v2 authoring lives as tabs inside the Fares
    // panel (like Transfers), gated by this toggle. Files listed for reference;
    // the exporter only emits a file once it has rows. Phase 1 ships the Areas
    // editor (areas.txt + stop_areas.txt); later phases add the rest.
    files: [
      'areas.txt', 'stop_areas.txt', 'networks.txt', 'route_networks.txt',
      'timeframes.txt', 'rider_categories.txt', 'fare_media.txt',
      'fare_products.txt', 'fare_leg_rules.txt', 'fare_transfer_rules.txt',
    ],
  },
];

export const FEATURE_BY_KEY: Record<AdvancedFeature, FeatureMeta> = Object.fromEntries(
  ADVANCED_FEATURES.map((f) => [f.key, f]),
) as Record<AdvancedFeature, FeatureMeta>;

// True when the feed already contains data for this feature — the signal that
// it's in use (so it auto-enables and can't be silently turned off).
export function featureHasData(s: AppStore, f: AdvancedFeature): boolean {
  switch (f) {
    case 'transfers': return s.transfers.length > 0;
    case 'frequencies': return s.frequencies.length > 0;
    case 'stations': return s.levels.length > 0 || s.pathways.length > 0;
    case 'blocks': return s.trips.some((t) => !!t.block_id);
    case 'demandResponse': return s.flexZones.length > 0;
    case 'serviceAlerts': return false; // alerts live server-side, not in the feed store
    case 'faresV2':
      // Any of the 10 v2 files carrying rows means the feed uses v2.
      return (
        s.fareAreas.length > 0 || s.stopAreas.length > 0 ||
        s.fareNetworks.length > 0 || s.routeNetworks.length > 0 ||
        s.timeframes.length > 0 || s.riderCategories.length > 0 ||
        s.fareMedia.length > 0 || s.fareProducts.length > 0 ||
        s.fareLegRules.length > 0 || s.fareTransferRules.length > 0
      );
  }
}

// Whether a feature's UI (nav section / Fares sub-tab) is shown. An explicit
// per-feed choice always wins — turning a feature off hides it even when the
// feed still has data (the data is kept and still exports; the Settings panel
// offers hide-vs-delete on toggle-off). With no explicit choice, demandResponse
// is on by default and the rest auto-show when the feed already contains their
// data — except `blocks` (autoShowOnData: false), hidden until opted in.
export function featureEnabled(s: AppStore, f: AdvancedFeature): boolean {
  const explicit = s.featureSettings[f];
  if (explicit !== undefined) return explicit;
  const meta = FEATURE_BY_KEY[f];
  if (meta.defaultEnabled) return meta.defaultEnabled(s);
  if (meta.defaultOn) return true;
  return meta.autoShowOnData !== false && featureHasData(s, f);
}

// Clear every row a feature owns — used when the user turns a feature off and
// confirms discarding its data ("destroy the file").
export function clearFeatureData(s: AppStore, f: AdvancedFeature): void {
  switch (f) {
    case 'transfers': s.setTransfers([]); break;
    case 'frequencies': s.setFrequencies([]); break;
    case 'stations': s.setLevels([]); s.setPathways([]); break;
    case 'demandResponse': s.setFlexZones([]); break;
    case 'blocks':
      // No file; strip block_id from every trip.
      s.setTrips(s.trips.map((t) => ({ ...t, block_id: undefined })));
      break;
    case 'serviceAlerts': break; // alerts aren't feed data — nothing to clear here
    case 'faresV2':
      // Clear every v2 file. v1 fares (fare_attributes/fare_rules) are a
      // separate feature and untouched.
      s.setFareAreas([]); s.setStopAreas([]);
      s.setFareNetworks([]); s.setRouteNetworks([]);
      s.setTimeframes([]); s.setRiderCategories([]);
      s.setFareMedia([]); s.setFareProducts([]);
      s.setFareLegRules([]); s.setFareTransferRules([]);
      break;
  }
}
