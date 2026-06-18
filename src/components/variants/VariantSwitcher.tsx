import { useState } from 'react';
import { useStore } from '../../store';
import {
  createVariantFromCurrent,
  switchToVariant,
  deleteVariant,
  discardVariants,
} from '../../services/variants';
import { VariantCompareDialog } from './VariantCompareDialog';
import { useCanUseVariants } from './useCanUseVariants';

/**
 * A2b — feed-variant switcher (header). Fork the feed into named variants,
 * switch the active one, mark a baseline, and open the baseline comparison.
 * Kept deliberately separate from the route-visibility "Scenarios" switcher.
 */
export function VariantSwitcher() {
  const variants = useStore((s) => s.variants);
  const activeVariantId = useStore((s) => s.activeVariantId);
  const setBaselineVariant = useStore((s) => s.setBaselineVariant);
  const canUse = useCanUseVariants();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [showCompare, setShowCompare] = useState(false);

  if (!canUse) return null;

  const active = variants.find((v) => v.id === activeVariantId);
  const onVariant = active && !active.baseline;

  const handleNew = () => {
    createVariantFromCurrent(newName);
    setNewName('');
    setOpen(false);
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Feed variants — fork the feed to compare service alternatives"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium border transition-colors max-w-[12rem] ${
          onVariant
            ? 'border-coral bg-coral/10 text-coral'
            : 'border-sand text-dark-brown hover:bg-cream'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
          <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7M8.4 6.6c4 .3 6.5 1.2 7.4 2.4" />
        </svg>
        <span className="truncate">{active ? active.name : 'Variants'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-warm-gray">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full mt-1 z-40 w-72 bg-white border border-sand rounded-xl shadow-lg p-1.5 flex flex-col">
            <div className="px-2 py-1">
              <div className="text-[11px] font-bold uppercase tracking-wide text-warm-gray">Variants</div>
              <div className="text-[11px] text-warm-gray/80">Fork the feed to compare service alternatives.</div>
            </div>

            {variants.length > 0 && (
              <div className="flex flex-col py-1">
                {variants.map((v) => (
                  <div key={v.id} className="group flex items-center rounded-md hover:bg-cream transition-colors">
                    <button
                      onClick={() => { switchToVariant(v.id); setOpen(false); }}
                      className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-sm text-left text-dark-brown"
                    >
                      <span className="w-3.5 shrink-0 text-teal">{v.id === activeVariantId ? '✓' : ''}</span>
                      <span className="truncate">{v.name}</span>
                      {v.baseline && <span className="shrink-0 px-1 py-0.5 rounded bg-sand text-[9px] font-bold text-warm-gray">BASE</span>}
                    </button>
                    {!v.baseline && (
                      <>
                        <button
                          onClick={() => setBaselineVariant(v.id)}
                          title="Make this the baseline"
                          className="px-1.5 py-1.5 text-warm-gray hover:text-teal transition-colors shrink-0 opacity-0 group-hover:opacity-100 text-xs"
                        >
                          ⌖
                        </button>
                        <button
                          onClick={() => deleteVariant(v.id)}
                          title="Delete variant"
                          className="px-1.5 py-1.5 text-warm-gray hover:text-red-600 transition-colors shrink-0"
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-sand my-1" />

            {/* New variant */}
            <div className="flex items-center gap-1 px-1 py-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNew()}
                placeholder={variants.length ? 'New variant name…' : 'Name your first variant…'}
                className="flex-1 min-w-0 px-2 py-1 text-xs border border-sand rounded-md bg-cream focus:border-coral focus:bg-white focus:outline-none"
              />
              <button
                onClick={handleNew}
                title="Fork a new variant from the current feed"
                className="px-2 py-1 rounded-md bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors shrink-0"
              >
                ＋ New
              </button>
            </div>

            {variants.length > 0 && (
              <>
                <div className="border-t border-sand my-1" />
                <button
                  onClick={() => { setShowCompare(true); setOpen(false); }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left text-dark-brown hover:bg-cream transition-colors"
                >
                  <span aria-hidden>📊</span> Compare to baseline
                </button>
                <button
                  onClick={() => { discardVariants(); setOpen(false); }}
                  title="Drop all variants and return the feed to the baseline"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left text-warm-gray hover:bg-cream hover:text-red-600 transition-colors"
                >
                  <span aria-hidden>✕</span> Discard variants
                </button>
              </>
            )}
          </div>
        </>
      )}

      {showCompare && <VariantCompareDialog onClose={() => setShowCompare(false)} />}
    </div>
  );
}
