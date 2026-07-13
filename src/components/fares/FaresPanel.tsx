import { useState } from 'react';
import { useStore } from '../../store';
import { featureEnabled } from '../../store/featuresSlice';
import { TabButton } from '../ui/Tabs';
import { FaresEditor } from './FaresEditor';
import { FareZoneTool } from './FareZoneTool';
import { AreasEditor } from './AreasEditor';
import { RiderCategoriesEditor } from './RiderCategoriesEditor';
import { FareMediaEditor } from './FareMediaEditor';
import { FareProductsEditor } from './FareProductsEditor';
import { NetworksEditor } from './NetworksEditor';
import { TimeframesEditor } from './TimeframesEditor';
import { FareLegRulesEditor } from './FareLegRulesEditor';
import { FareTransferRulesEditor } from './FareTransferRulesEditor';
import { TransfersEditor } from '../transfers/TransfersEditor';

/**
 * Combined Fares + Transfers panel. transfers.txt is conceptually adjacent to
 * fare data (both describe inter-route relationships) and rare enough in
 * authoring that giving it its own sidebar entry was disproportionate. Tabs
 * keep both reachable in one place without crowding the rail.
 *
 * GTFS-Fares v2 authoring also lives here, gated behind the per-feed "Fares v2"
 * feature toggle. All seven v2 files (areas, rider categories, fare media,
 * fare products, networks, timeframes, leg + transfer rules) share a single
 * top-level "Fares v2" tab with a compact sub-nav so the rail stays uncrowded.
 */
type FaresTab = 'fares' | 'zones' | 'v2' | 'transfers';

// The v2 sub-sections, in the fare-pricing chain order (reference data first,
// then the rules that compose it). Each maps to one v2 file (or file pair).
type V2Section =
  | 'areas' | 'riders' | 'media' | 'products'
  | 'networks' | 'timeframes' | 'legRules' | 'transferRules';

const V2_SECTIONS: { key: V2Section; label: string; countSel: (s: ReturnType<typeof useStore.getState>) => number }[] = [
  { key: 'areas', label: 'Areas', countSel: (s) => s.fareAreas.length },
  { key: 'networks', label: 'Networks', countSel: (s) => s.fareNetworks.length },
  { key: 'riders', label: 'Riders', countSel: (s) => s.riderCategories.length },
  { key: 'media', label: 'Media', countSel: (s) => s.fareMedia.length },
  { key: 'products', label: 'Products', countSel: (s) => s.fareProducts.length },
  { key: 'timeframes', label: 'Timeframes', countSel: (s) => s.timeframes.length },
  { key: 'legRules', label: 'Leg Rules', countSel: (s) => s.fareLegRules.length },
  { key: 'transferRules', label: 'Transfer Rules', countSel: (s) => s.fareTransferRules.length },
];

export function FaresPanel() {
  const transferCount = useStore((s) => s.transfers.length);
  // Transfers + Fares v2 are gated by per-feed feature settings (Settings
  // panel). A hidden tab → fall back to Fares so we never render a dead tab.
  const showTransfers = useStore((s) => featureEnabled(s, 'transfers'));
  const showFaresV2 = useStore((s) => featureEnabled(s, 'faresV2'));
  const v2State = useStore();

  const [tab, setTab] = useState<FaresTab>('fares');
  const [v2Section, setV2Section] = useState<V2Section>('areas');

  let effectiveTab: FaresTab = tab;
  if (effectiveTab === 'transfers' && !showTransfers) effectiveTab = 'fares';
  if (effectiveTab === 'v2' && !showFaresV2) effectiveTab = 'fares';

  return (
    <div>
      <div className="flex gap-1 -mt-1 mb-4 border-b border-sand">
        <TabButton active={effectiveTab === 'fares'} onClick={() => setTab('fares')}>
          Fares
        </TabButton>
        <TabButton active={effectiveTab === 'zones'} onClick={() => setTab('zones')}>
          Zones
        </TabButton>
        {showFaresV2 && (
          <TabButton active={effectiveTab === 'v2'} onClick={() => setTab('v2')}>
            Fares v2
          </TabButton>
        )}
        {showTransfers && (
          <TabButton active={effectiveTab === 'transfers'} onClick={() => setTab('transfers')} className="flex items-center">
            Transfers
            {transferCount > 0 && (
              <span
                className={`ml-1.5 inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded text-[10px] font-bold tabular-nums ${
                  effectiveTab === 'transfers' ? 'bg-coral text-white' : 'bg-sand text-warm-gray'
                }`}
              >
                {transferCount.toLocaleString()}
              </span>
            )}
          </TabButton>
        )}
      </div>

      {effectiveTab === 'v2' && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {V2_SECTIONS.map(({ key, label, countSel }) => {
            const count = countSel(v2State);
            const active = v2Section === key;
            return (
              <button
                key={key}
                onClick={() => setV2Section(key)}
                className={`px-2.5 py-1 rounded-full text-[12px] font-heading font-semibold transition-colors flex items-center gap-1 ${
                  active
                    ? 'bg-coral text-white'
                    : 'bg-cream text-warm-gray hover:bg-sand hover:text-dark-brown'
                }`}
              >
                {label}
                {count > 0 && (
                  <span className={`tabular-nums text-[10px] ${active ? 'text-white/80' : 'text-warm-gray'}`}>
                    {count.toLocaleString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {effectiveTab === 'fares' ? (
        <FaresEditor />
      ) : effectiveTab === 'zones' ? (
        <FareZoneTool />
      ) : effectiveTab === 'transfers' ? (
        <TransfersEditor />
      ) : (
        <V2SectionBody section={v2Section} />
      )}
    </div>
  );
}

function V2SectionBody({ section }: { section: V2Section }) {
  switch (section) {
    case 'areas': return <AreasEditor />;
    case 'networks': return <NetworksEditor />;
    case 'riders': return <RiderCategoriesEditor />;
    case 'media': return <FareMediaEditor />;
    case 'products': return <FareProductsEditor />;
    case 'timeframes': return <TimeframesEditor />;
    case 'legRules': return <FareLegRulesEditor />;
    case 'transferRules': return <FareTransferRulesEditor />;
  }
}

