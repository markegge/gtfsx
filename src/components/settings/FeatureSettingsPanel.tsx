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

// Human description of the data a feature owns, for the hide-vs-delete prompt.
function describeData(s: AppStore, f: AdvancedFeature): string {
  switch (f) {
    case 'frequencies': return `${s.frequencies.length} frequency rule(s)`;
    case 'transfers': return `${s.transfers.length} transfer rule(s)`;
    case 'stations': return `${s.levels.length} level(s) and ${s.pathways.length} pathway(s)`;
    case 'blocks': return `${s.trips.filter((t) => !!t.block_id).length} block assignment(s)`;
    case 'demandResponse': return `${s.flexZones.length} flex zone(s)`;
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPending(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-md w-full p-6"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-dark-brown">Turn off {FEATURE_BY_KEY[pending].label}?</h3>
            <p className="mt-2 text-sm text-warm-gray">
              This feed has {describeData(s, pending)}. You can hide {FEATURE_BY_KEY[pending].label} from
              the editor and keep the data — it still exports in your GTFS — or delete the data from the
              feed entirely.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-warm-gray hover:bg-sand transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => hideFeature(pending)}
                className="px-4 py-2 rounded-lg text-sm font-semibold border border-sand text-dark-brown hover:bg-cream transition-colors"
              >
                Hide, keep data
              </button>
              <button
                type="button"
                onClick={() => deleteFeatureData(pending)}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Delete data
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
