import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Badge } from '../ui/Badge';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { RiderCategory } from '../../types/gtfs';

/**
 * GTFS-Fares v2 Rider Categories editor (rider_categories.txt). A rider
 * category is a first-class rider type (adult, senior, student, …) that
 * fare_products reference. rider_category_id is unique and required;
 * rider_category_name is required by the spec. is_default_fare_category marks
 * the category applied when no rider is specified (at most one should be the
 * default — validation flags more).
 */
export function RiderCategoriesEditor() {
  const riderCategories = useStore((s) => s.riderCategories);
  const addRiderCategory = useStore((s) => s.addRiderCategory);
  const updateRiderCategory = useStore((s) => s.updateRiderCategory);
  const renameRiderCategoryId = useStore((s) => s.renameRiderCategoryId);
  const removeRiderCategory = useStore((s) => s.removeRiderCategory);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();

  const selected = riderCategories.find((c) => c.rider_category_id === selectedId) ?? null;

  const open = (id: string | null) => {
    setSelectedId(id);
    const c = riderCategories.find((x) => x.rider_category_id === id);
    setIdDraft(c?.rider_category_id ?? '');
    setIdError(undefined);
  };

  const handleAdd = () => {
    const cat: RiderCategory = { rider_category_id: generateId('rider'), rider_category_name: '' };
    addRiderCategory(cat);
    open(cat.rider_category_id);
  };

  const commitId = () => {
    if (!selected) return;
    const next = idDraft.trim();
    if (!next) {
      setIdError('Rider category ID is required.');
      setIdDraft(selected.rider_category_id);
      return;
    }
    if (next === selected.rider_category_id) { setIdError(undefined); return; }
    if (riderCategories.some((c) => c.rider_category_id === next)) {
      setIdError(`Rider category ID "${next}" is already in use.`);
      return;
    }
    renameRiderCategoryId(selected.rider_category_id, next);
    setSelectedId(next);
    setIdError(undefined);
  };

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            <strong>Rider categories</strong> are the rider types your fares apply to (adult, senior,
            student, …). Fare products reference a category to set a per-rider price.
          </p>
        </div>

        <RailSubHeading count={riderCategories.length}>Rider Categories</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {riderCategories.map((c) => (
            <button
              key={c.rider_category_id}
              onClick={() => open(c.rider_category_id)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">
                  {c.rider_category_name || c.rider_category_id}
                </span>
                {c.is_default_fare_category === 1 && <Badge variant="info">Default</Badge>}
              </div>
              <div className="text-[11px] text-warm-gray mt-0.5 font-mono">{c.rider_category_id}</div>
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add Rider Category
        </button>
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray flex items-center gap-1.5 mb-1">
        <button onClick={() => open(null)} className="hover:text-coral transition-colors">‹</button>
        <button onClick={() => open(null)} className="hover:text-coral transition-colors">Rider Categories</button>
        <span className="opacity-50">›</span>
        <span className="text-dark-brown font-semibold truncate">
          {selected.rider_category_name || selected.rider_category_id}
        </span>
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          {selected.rider_category_name || selected.rider_category_id}
        </h2>
        <EditActions
          onDelete={() => { removeRiderCategory(selected.rider_category_id); open(null); }}
          deleteTitle="Delete this rider category"
        />
      </div>

      <FormField
        label="Rider Category ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder="rider_category_id"
        required
        error={idError}
      />
      {idDraft.trim() !== selected.rider_category_id && (
        <button
          onClick={commitId}
          className="mb-4 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          Rename to “{idDraft.trim() || '…'}”
        </button>
      )}

      <FormField
        label="Rider Category Name"
        value={selected.rider_category_name ?? ''}
        onChange={(v) => updateRiderCategory(selected.rider_category_id, { rider_category_name: v })}
        placeholder="e.g. Senior"
        required
      />

      <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={selected.is_default_fare_category === 1}
          onChange={(e) => updateRiderCategory(selected.rider_category_id, {
            is_default_fare_category: e.target.checked ? 1 : undefined,
          })}
          className="accent-coral w-4 h-4"
        />
        <span className="text-sm text-dark-brown">Default fare category</span>
      </label>

      <FormField
        label="Eligibility URL"
        value={selected.eligibility_url ?? ''}
        onChange={(v) => updateRiderCategory(selected.rider_category_id, { eligibility_url: v || undefined })}
        placeholder="https://… (optional)"
      />
    </div>
  );
}
