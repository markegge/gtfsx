import { useState } from 'react';
import { useStore } from '../../store';
import {
  ADVANCED_FEATURES,
  FEATURE_BY_KEY,
  featureEnabled,
  featureHasData,
  clearFeatureData,
  type AdvancedFeature,
} from '../../store/featuresSlice';
import type { AppStore } from '../../store';
import { Modal } from '../ui/Modal';
import { AuthButton } from '../auth/AuthButton';

// Human description of the data a feature owns, for the hide-vs-delete prompt.
function describeData(s: AppStore, f: AdvancedFeature): string {
  switch (f) {
    case 'frequencies': return `${s.frequencies.length} frequency rule(s)`;
    case 'transfers': return `${s.transfers.length} transfer rule(s)`;
    case 'stations': return `${s.levels.length} level(s) and ${s.pathways.length} pathway(s)`;
    case 'blocks': return `${s.trips.filter((t) => !!t.block_id).length} block assignment(s)`;
    case 'demandResponse': return `${s.flexZones.length} flex zone(s)`;
    case 'serviceAlerts': return 'service alerts'; // alerts aren't feed data; this prompt won't fire
    case 'faresV2': {
      const total =
        s.fareAreas.length + s.stopAreas.length +
        s.fareNetworks.length + s.routeNetworks.length +
        s.timeframes.length + s.riderCategories.length +
        s.fareMedia.length + s.fareProducts.length +
        s.fareLegRules.length + s.fareTransferRules.length;
      return `${total} Fares v2 record(s) across areas, stop areas, and other v2 files`;
    }
    case 'continuousStops': {
      const routeCount = s.routes.filter(
        (r) => r.continuous_pickup !== undefined || r.continuous_drop_off !== undefined,
      ).length;
      const stopTimeCount = s.stopTimes.filter(
        (st) => st.continuous_pickup !== undefined || st.continuous_drop_off !== undefined,
      ).length;
      return `${routeCount} route(s) and ${stopTimeCount} stop time(s) with continuous pickup/drop-off`;
    }
  }
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-coral' : 'bg-sand'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function FeatureSettingsPanel() {
  // Settings panel isn't perf-critical and reads across many slices, so it
  // subscribes to the whole store.
  const s = useStore();
  // Feature whose toggle-off-with-data prompt is open, if any.
  const [pending, setPending] = useState<AdvancedFeature | null>(null);

  const onToggle = (f: AdvancedFeature, next: boolean) => {
    if (next) {
      s.setFeatureSetting(f, true);
      return;
    }
    // Turning off. If the feed has data, let the user choose hide vs delete;
    // otherwise just hide it.
    if (featureHasData(s, f)) {
      setPending(f);
      return;
    }
    s.setFeatureSetting(f, false);
  };

  // Hide the feature but keep its data (still exported; just not shown).
  const hideFeature = (f: AdvancedFeature) => {
    s.setFeatureSetting(f, false);
    setPending(null);
  };

  // Delete the feature's data from the feed and hide it.
  const deleteFeatureData = (f: AdvancedFeature) => {
    clearFeatureData(s, f);
    s.setFeatureSetting(f, false);
    setPending(null);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-warm-gray">
        Turn advanced GTFS features on or off for this feed. Anything off is hidden
        from the editor to keep the workspace simple — turning it on (or importing a
        feed that already uses it) brings it back. These choices live with the feed and
        don&rsquo;t change the GTFS you export.
      </p>

      <div className="space-y-3">
        {ADVANCED_FEATURES.map((f) => {
          const enabled = featureEnabled(s, f.key);
          const inUse = featureHasData(s, f.key);
          return (
            <div key={f.key} className="rounded-lg border border-sand bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-dark-brown">{f.label}</span>
                    {inUse && (
                      <span className="text-[10px] font-bold uppercase tracking-wide rounded-full bg-teal-light text-teal px-2 py-0.5">
                        In use
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-warm-gray">{f.description}</p>
                </div>
                <Switch checked={enabled} onChange={(next) => onToggle(f.key, next)} label={f.label} />
              </div>
            </div>
          );
        })}
      </div>

      {pending && (
        <Modal
          open
          onClose={() => setPending(null)}
          maxWidthClassName="max-w-md"
          title={`Turn off ${FEATURE_BY_KEY[pending].label}?`}
          description={
            <>
              This feed has {describeData(s, pending)}. You can hide {FEATURE_BY_KEY[pending].label} from
              the editor and keep the data — it still exports in your GTFS — or delete the data from the
              feed entirely.
            </>
          }
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <AuthButton variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </AuthButton>
              <AuthButton variant="secondary" onClick={() => hideFeature(pending)}>
                Hide, keep data
              </AuthButton>
              <AuthButton variant="danger" onClick={() => deleteFeatureData(pending)}>
                Delete data
              </AuthButton>
            </div>
          }
        />
      )}
    </div>
  );
}
