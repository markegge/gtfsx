import { useState } from 'react';
import { useStore } from '../../store';
import { VariantsPanel } from './VariantsPanel';
import { useCanUseVariants } from './useCanUseVariants';

/**
 * A2b — TopBar entry point for feed variants. Shows the active variant and opens
 * the full management panel (fork / switch / rename / duplicate / delete /
 * promote-to-baseline / compare). Distinct from the basic per-route visibility
 * toggle (hiddenRouteIds). Agency+ (self-hides otherwise).
 */
export function VariantSwitcher() {
  const variants = useStore((s) => s.variants);
  const activeVariantId = useStore((s) => s.activeVariantId);
  const canUse = useCanUseVariants();
  const [open, setOpen] = useState(false);

  if (!canUse) return null;

  const active = variants.find((v) => v.id === activeVariantId);
  const onVariant = active && !active.baseline;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Feed variants — fork the feed to compare and plan service alternatives"
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
        {variants.length > 0 && (
          <span className="shrink-0 rounded-full bg-sand text-warm-gray text-[10px] font-bold px-1.5 py-0.5 leading-none">
            {variants.length}
          </span>
        )}
      </button>

      {open && <VariantsPanel onClose={() => setOpen(false)} />}
    </>
  );
}
