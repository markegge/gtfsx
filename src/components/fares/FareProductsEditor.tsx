import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareProduct } from '../../types/gtfs';

/**
 * GTFS-Fares v2 Fare Products editor (fare_products.txt). A fare product is the
 * purchasable thing (single ride, day pass, …) with a price. It optionally
 * references a rider_category and a fare_media (foreign keys, picked from
 * dropdowns). fare_product_id, amount, and currency are required.
 */
export function FareProductsEditor() {
  const fareProducts = useStore((s) => s.fareProducts);
  const riderCategories = useStore((s) => s.riderCategories);
  const fareMedia = useStore((s) => s.fareMedia);
  const addFareProduct = useStore((s) => s.addFareProduct);
  const updateFareProduct = useStore((s) => s.updateFareProduct);
  const renameFareProductId = useStore((s) => s.renameFareProductId);
  const removeFareProduct = useStore((s) => s.removeFareProduct);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();

  const selected = fareProducts.find((p) => p.fare_product_id === selectedId) ?? null;

  const riderName = (id?: string) =>
    riderCategories.find((c) => c.rider_category_id === id)?.rider_category_name || id;
  const mediaName = (id?: string) =>
    fareMedia.find((m) => m.fare_media_id === id)?.fare_media_name || id;

  const open = (id: string | null) => {
    setSelectedId(id);
    const p = fareProducts.find((x) => x.fare_product_id === id);
    setIdDraft(p?.fare_product_id ?? '');
    setIdError(undefined);
  };

  const handleAdd = () => {
    const product: FareProduct = {
      fare_product_id: generateId('product'),
      amount: '',
      currency: 'USD',
    };
    addFareProduct(product);
    open(product.fare_product_id);
  };

  const commitId = () => {
    if (!selected) return;
    const next = idDraft.trim();
    if (!next) {
      setIdError('Fare product ID is required.');
      setIdDraft(selected.fare_product_id);
      return;
    }
    if (next === selected.fare_product_id) { setIdError(undefined); return; }
    if (fareProducts.some((p) => p.fare_product_id === next)) {
      setIdError(`Fare product ID "${next}" is already in use.`);
      return;
    }
    renameFareProductId(selected.fare_product_id, next);
    setSelectedId(next);
    setIdError(undefined);
  };

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            <strong>Fare products</strong> are the priced things a rider buys (single ride, day
            pass). Each has an amount and currency, and can be scoped to a rider category and fare
            medium. Leg and transfer rules point at products.
          </p>
        </div>

        <RailSubHeading count={fareProducts.length}>Fare Products</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {fareProducts.map((p) => (
            <button
              key={p.fare_product_id}
              onClick={() => open(p.fare_product_id)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">
                  {p.fare_product_name || p.fare_product_id}
                </span>
                <span className="text-[11px] text-warm-gray shrink-0 font-mono">
                  {p.amount !== '' ? `${p.amount} ${p.currency}` : '— ' + p.currency}
                </span>
              </div>
              <div className="text-[11px] text-warm-gray mt-0.5 truncate">
                {[riderName(p.rider_category_id), mediaName(p.fare_media_id)].filter(Boolean).join(' · ') || p.fare_product_id}
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add Fare Product
        </button>
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray flex items-center gap-1.5 mb-1">
        <button onClick={() => open(null)} className="hover:text-coral transition-colors">‹</button>
        <button onClick={() => open(null)} className="hover:text-coral transition-colors">Fare Products</button>
        <span className="opacity-50">›</span>
        <span className="text-dark-brown font-semibold truncate">
          {selected.fare_product_name || selected.fare_product_id}
        </span>
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          {selected.fare_product_name || selected.fare_product_id}
        </h2>
        <EditActions
          onDelete={() => { removeFareProduct(selected.fare_product_id); open(null); }}
          deleteTitle="Delete this fare product"
        />
      </div>

      <FormField
        label="Fare Product ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder="fare_product_id"
        required
        error={idError}
      />
      {idDraft.trim() !== selected.fare_product_id && (
        <button
          onClick={commitId}
          className="mb-4 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          Rename to “{idDraft.trim() || '…'}”
        </button>
      )}

      <FormField
        label="Fare Product Name"
        value={selected.fare_product_name ?? ''}
        onChange={(v) => updateFareProduct(selected.fare_product_id, { fare_product_name: v || undefined })}
        placeholder="e.g. Single Ride (optional)"
      />

      <div className="grid grid-cols-2 gap-2">
        <FormField
          label="Amount"
          value={selected.amount}
          onChange={(v) => updateFareProduct(selected.fare_product_id, { amount: v })}
          placeholder="2.50"
          required
        />
        <FormField
          label="Currency"
          value={selected.currency}
          onChange={(v) => updateFareProduct(selected.fare_product_id, { currency: v.toUpperCase() })}
          placeholder="USD"
          required
        />
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Rider Category
        </label>
        <select
          value={selected.rider_category_id ?? ''}
          onChange={(e) => updateFareProduct(selected.fare_product_id, {
            rider_category_id: e.target.value || undefined,
          })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          <option value="">Any rider (none)</option>
          {riderCategories.map((c) => (
            <option key={c.rider_category_id} value={c.rider_category_id}>
              {c.rider_category_name || c.rider_category_id}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Fare Media
        </label>
        <select
          value={selected.fare_media_id ?? ''}
          onChange={(e) => updateFareProduct(selected.fare_product_id, {
            fare_media_id: e.target.value || undefined,
          })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          <option value="">Any medium (none)</option>
          {fareMedia.map((m) => (
            <option key={m.fare_media_id} value={m.fare_media_id}>
              {m.fare_media_name || m.fare_media_id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
