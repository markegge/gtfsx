import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { VariantCompareDialog } from './VariantCompareDialog';
import { useCanUseVariants } from './useCanUseVariants';
import { relativeTime } from '../community/time';
import {
  createVariantFromCurrent,
  switchToVariant,
  deleteVariant,
  discardVariants,
  duplicateVariant,
  promoteToBaseline,
  compareVariants,
  variantFeedState,
  priorBaselineName,
} from '../../services/variants';
import { peekVariantSpatialMetrics, type SpatialMetrics } from '../../services/variantSpatialMetrics';
import { summarizeDiff, rowActions } from './variantPanelHelpers';
import type { FeedVariant } from '../../store/variantSlice';
import type { FeedDiff } from '../../services/feedDiff';

/**
 * A2 — the variants management panel, living in the RightRail (opened from the
 * TopBar variants dropdown's "Manage variants…"). Lists baseline + every variant
 * with a compact change summary and full CRUD: switch, rename (inline), duplicate
 * (from any variant), delete (baseline protected), promote-to-baseline (headline),
 * and a per-row compare shortcut. Agency+ (inherits the variants gate).
 *
 * Spatial stats show ONLY when already cached (peekVariantSpatialMetrics — a sync
 * read); the panel never triggers a compute. Entity deltas come from the cheap
 * feedDiff counts, recomputed only when the variant set / active pointer changes.
 */
export function VariantsPanel() {
  const canUse = useCanUseVariants();
  const variants = useStore((s) => s.variants);
  const activeVariantId = useStore((s) => s.activeVariantId);
  const renameVariant = useStore((s) => s.renameVariant);
  const markDirty = useStore((s) => s.markDirty);
  const setSidebarSection = useStore((s) => s.setSidebarSection);

  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<FeedVariant | null>(null);
  const [confirmPromote, setConfirmPromote] = useState<FeedVariant | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [compareBId, setCompareBId] = useState<string | null>(null);

  const baseline = variants.find((v) => v.baseline) ?? null;
  const baselineId = baseline?.id ?? '';

  // Per-variant entity delta vs baseline (cheap counts).
  const diffs = useMemo(() => {
    const m = new Map<string, FeedDiff | null>();
    for (const v of variants) {
      m.set(v.id, v.baseline || !baselineId ? null : compareVariants(baselineId, v.id));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, baselineId, activeVariantId]);

  if (!canUse) {
    return <p className="text-sm text-warm-gray">Variants are an Agency-plan feature.</p>;
  }

  const handleNew = () => {
    createVariantFromCurrent(newName);
    setNewName('');
  };
  const startRename = (v: FeedVariant) => {
    setRenamingId(v.id);
    setRenameValue(v.name);
  };
  const commitRename = () => {
    if (renamingId) {
      renameVariant(renamingId, renameValue);
      markDirty();
    }
    setRenamingId(null);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-warm-gray">
        Fork the feed to compare and plan service alternatives. Variants are saved with your
        project; Save keeps your baseline as the feed and all variants alongside it.
      </p>

      {variants.length === 0 ? (
        <div className="rounded-lg border border-sand bg-cream/50 p-4 text-center text-sm text-warm-gray">
          No variants yet. Name one below to fork the current feed without touching your baseline.
        </div>
      ) : (
        <div className="space-y-2">
          {variants.map((v) => (
            <VariantRow
              key={v.id}
              variant={v}
              isActive={v.id === activeVariantId}
              diff={diffs.get(v.id) ?? null}
              baselineId={baselineId}
              renaming={renamingId === v.id}
              renameValue={renameValue}
              onRenameValue={setRenameValue}
              onStartRename={() => startRename(v)}
              onCommitRename={commitRename}
              onSwitch={() => switchToVariant(v.id)}
              onDuplicate={() => duplicateVariant(v.id)}
              onDelete={() => setConfirmDelete(v)}
              onPromote={() => setConfirmPromote(v)}
              onCompare={() => setCompareBId(v.id)}
            />
          ))}
        </div>
      )}

      {/* Create a new variant from the current feed. */}
      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNew()}
          placeholder={variants.length ? 'New variant name…' : 'Name your first variant…'}
          className="flex-1 min-w-0 px-2.5 py-1.5 text-sm border border-sand rounded-lg bg-cream focus:border-coral focus:bg-white focus:outline-none"
        />
        <button
          onClick={handleNew}
          title="Fork a new variant from the current feed"
          className="px-3 py-1.5 rounded-lg bg-coral text-white text-sm font-heading font-bold hover:bg-[#d4603a] transition-colors shrink-0"
        >
          ＋ New
        </button>
      </div>

      {variants.length > 0 && (
        <button
          onClick={() => setConfirmDiscard(true)}
          className="text-xs font-semibold text-warm-gray hover:text-red-600 transition-colors"
        >
          Discard all variants
        </button>
      )}

      {confirmDelete && (
        <ConfirmDialog
          danger
          title={`Delete "${confirmDelete.name}"?`}
          body={
            <>
              This removes the variant and its edits from the set.
              {confirmDelete.id === activeVariantId && ' You’ll be switched back to the baseline.'}
              {' '}Nothing is written until you Save.
            </>
          }
          confirmLabel="Delete variant"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteVariant(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}

      {confirmPromote && baseline && (
        <ConfirmDialog
          title={`Make "${confirmPromote.name}" the baseline?`}
          body={
            <div className="space-y-2">
              <p>
                <strong className="text-dark-brown">{confirmPromote.name}</strong> becomes your baseline —
                the canonical feed that Save writes and that exports/publishes.
              </p>
              <p>
                Your current baseline is kept as a variant named{' '}
                <strong className="text-dark-brown">
                  {priorBaselineName(
                    confirmPromote.name,
                    ['Baseline', ...variants.filter((v) => v.id !== confirmPromote.id && !v.baseline).map((v) => v.name)],
                  )}
                </strong>, and your other variants keep their changes. Nothing is lost. Save to persist the new arrangement.
              </p>
            </div>
          }
          confirmLabel="Promote to baseline"
          onCancel={() => setConfirmPromote(null)}
          onConfirm={() => {
            promoteToBaseline(confirmPromote.id);
            setConfirmPromote(null);
          }}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog
          danger
          title="Discard all variants?"
          body="This drops the whole variant set and returns the editor to the baseline feed. Nothing is written until you Save."
          confirmLabel="Discard variants"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            discardVariants();
            setConfirmDiscard(false);
            setSidebarSection(null);
          }}
        />
      )}

      {compareBId && (
        <VariantCompareDialog
          initialAId={baselineId}
          initialBId={compareBId}
          onClose={() => setCompareBId(null)}
        />
      )}
    </div>
  );
}

/* ──────────────────────────── row ──────────────────────────── */

function spatialChip(id: string): { residents: number } | null {
  const feed = variantFeedState(id);
  if (!feed) return null;
  const m: SpatialMetrics | null = peekVariantSpatialMetrics(id, {
    stops: feed.stops,
    routes: feed.routes,
    routeStops: feed.routeStops,
  });
  return m ? { residents: m.population } : null;
}

function VariantRow({
  variant,
  isActive,
  diff,
  baselineId,
  renaming,
  renameValue,
  onRenameValue,
  onStartRename,
  onCommitRename,
  onSwitch,
  onDuplicate,
  onDelete,
  onPromote,
  onCompare,
}: {
  variant: FeedVariant;
  isActive: boolean;
  diff: FeedDiff | null;
  baselineId: string;
  renaming: boolean;
  renameValue: string;
  onRenameValue: (v: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onSwitch: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onPromote: () => void;
  onCompare: () => void;
}) {
  const actions = rowActions(variant, isActive);
  const chips = variant.baseline ? [] : summarizeDiff(diff);
  const spatial = spatialChip(variant.id);
  const baseSpatial = variant.baseline ? null : spatialChip(baselineId);

  return (
    <div
      className={`rounded-lg border p-2.5 flex flex-col gap-1 transition-colors ${
        isActive ? 'border-coral bg-coral/5' : 'border-sand hover:bg-cream/60'
      }`}
    >
      {/* Line 1: active indicator + name + badges + actions */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`shrink-0 w-2 h-2 rounded-full ${isActive ? 'bg-coral' : 'bg-transparent border border-warm-gray/40'}`}
          aria-hidden
        />
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => onRenameValue(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitRename();
              if (e.key === 'Escape') onCommitRename();
            }}
            className="flex-1 min-w-0 px-2 py-1 text-sm border-2 border-coral rounded-md bg-white outline-none"
          />
        ) : (
          <button
            onClick={isActive ? undefined : onSwitch}
            disabled={isActive}
            title={isActive ? 'Active variant' : 'Switch to this variant'}
            className={`min-w-0 text-left text-sm font-semibold truncate ${
              isActive ? 'text-coral cursor-default' : 'text-dark-brown hover:text-coral'
            }`}
          >
            {variant.name}
          </button>
        )}
        {variant.baseline && (
          <span className="shrink-0 px-1.5 py-0.5 rounded bg-sand text-[9px] font-bold text-warm-gray">BASELINE</span>
        )}
        {isActive && !variant.baseline && (
          <span className="shrink-0 px-1.5 py-0.5 rounded bg-coral/15 text-[9px] font-bold text-coral">ACTIVE</span>
        )}
        <span className="flex-1" />

        {actions.canPromote && (
          <button
            onClick={onPromote}
            title="Make this the baseline feed"
            className="shrink-0 px-2 py-1 rounded-md text-[11px] font-bold text-teal hover:bg-teal/10 transition-colors"
          >
            Make baseline
          </button>
        )}
        {actions.canCompare && <IconBtn label="Compare to baseline" onClick={onCompare}>📊</IconBtn>}
        <IconBtn label="Rename" onClick={onStartRename}>✎</IconBtn>
        <IconBtn label="Duplicate" onClick={onDuplicate}>⧉</IconBtn>
        {actions.canDelete && <IconBtn label="Delete" onClick={onDelete} danger>×</IconBtn>}
      </div>

      {/* Line 2: timestamps + change + spatial (muted) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-[11px] text-warm-gray">
        <span title={new Date(variant.createdAt).toLocaleString()}>
          Created {relativeTime(variant.createdAt)}
        </span>
        {variant.modifiedAt > variant.createdAt && (
          <span title={new Date(variant.modifiedAt).toLocaleString()}>· Modified {relativeTime(variant.modifiedAt)}</span>
        )}
        {variant.baseline ? (
          <span className="text-warm-gray/80">· reference feed</span>
        ) : chips.length ? (
          <span className="text-dark-brown">· {chips.join(' · ')}</span>
        ) : (
          <span className="text-warm-gray/80">· no changes vs baseline</span>
        )}
        {spatial && (
          <span className="text-warm-gray/90" title="From the cached coverage computation">
            · ≈{spatial.residents.toLocaleString()} residents
            {baseSpatial && spatial.residents !== baseSpatial.residents
              ? ` (${spatial.residents > baseSpatial.residents ? '+' : '−'}${Math.abs(spatial.residents - baseSpatial.residents).toLocaleString()})`
              : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-sm transition-colors ${
        danger ? 'text-warm-gray hover:text-red-600 hover:bg-red-50' : 'text-warm-gray hover:text-coral hover:bg-cream'
      }`}
    >
      {children}
    </button>
  );
}
