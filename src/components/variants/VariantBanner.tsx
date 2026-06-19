import { useState } from 'react';
import { useStore } from '../../store';
import { switchToVariant, baselineVariant } from '../../services/variants';
import { VariantCompareDialog } from './VariantCompareDialog';
import { useCanUseVariants } from './useCanUseVariants';

/**
 * Slim banner shown while a NON-baseline variant is active, so it's always
 * obvious you're editing a fork (not your baseline / saved feed) — and a Save
 * here saves the variant. Mirrors WelcomeBanner / PartnerBanner placement.
 * Agency+ only (mirrors VariantSwitcher's useCanUseVariants gate).
 */
export function VariantBanner() {
  const canUse = useCanUseVariants();
  const variants = useStore((s) => s.variants);
  const activeVariantId = useStore((s) => s.activeVariantId);
  const [showCompare, setShowCompare] = useState(false);

  if (!canUse) return null;
  const active = variants.find((v) => v.id === activeVariantId);
  if (!active || active.baseline) return null;

  return (
    <div className="shrink-0 bg-coral/10 border-b border-coral/30 px-4 py-1.5 flex items-center gap-3 text-xs">
      <span className="font-semibold text-coral flex items-center gap-1.5">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7M8.4 6.6c4 .3 6.5 1.2 7.4 2.4" />
        </svg>
        Editing variant: {active.name}
      </span>
      <span className="text-warm-gray hidden sm:inline">Changes here stay in this variant, separate from your baseline.</span>
      <span className="flex-1" />
      <button onClick={() => setShowCompare(true)} className="font-semibold text-coral hover:underline">Compare</button>
      <button
        onClick={() => { const b = baselineVariant(); if (b) switchToVariant(b.id); }}
        className="font-semibold text-warm-gray hover:text-dark-brown"
      >
        Back to baseline
      </button>
      {showCompare && <VariantCompareDialog onClose={() => setShowCompare(false)} />}
    </div>
  );
}
