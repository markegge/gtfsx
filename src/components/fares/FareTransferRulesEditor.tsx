import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import type { FareTransferRule } from '../../types/gtfs';

const TRANSFER_TYPES: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: 'Free transfer (no cost)' },
  { value: 1, label: 'Product is the transfer price' },
  { value: 2, label: 'Product is a discount on the next leg' },
];

const DURATION_TYPES: { value: 0 | 1; label: string }[] = [
  { value: 0, label: 'Between sequential legs' },
  { value: 1, label: 'From start of previous leg' },
];

/**
 * GTFS-Fares v2 Fare Transfer Rules editor (fare_transfer_rules.txt). A transfer
 * rule prices the transition between two leg groups. fare_transfer_type is
 * required; from/to_leg_group_id (drawn from leg rules) scope the rule;
 * fare_product_id is required when the type charges or discounts (1 or 2).
 * Rows are addressed by index (no single-column key).
 */
export function FareTransferRulesEditor() {
  const fareTransferRules = useStore((s) => s.fareTransferRules);
  const fareLegRules = useStore((s) => s.fareLegRules);
  const fareProducts = useStore((s) => s.fareProducts);
  const addFareTransferRule = useStore((s) => s.addFareTransferRule);
  const updateFareTransferRule = useStore((s) => s.updateFareTransferRule);
  const removeFareTransferRule = useStore((s) => s.removeFareTransferRule);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const selected = selectedIndex != null ? fareTransferRules[selectedIndex] ?? null : null;

  // Leg group ids come from leg rules (the only place they're defined).
  const legGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of fareLegRules) if (r.leg_group_id) ids.add(r.leg_group_id);
    return [...ids];
  }, [fareLegRules]);

  const typeLabel = (t: number) => TRANSFER_TYPES.find((x) => x.value === t)?.label ?? `Type ${t}`;
  const productLabel = (id?: string) =>
    fareProducts.find((p) => p.fare_product_id === id)?.fare_product_name || id;

  const handleAdd = () => {
    const rule: FareTransferRule = { fare_transfer_type: 0 };
    addFareTransferRule(rule);
    setSelectedIndex(fareTransferRules.length);
  };

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            <strong>Transfer rules</strong> price the move between two leg groups — a free transfer,
            a flat transfer fare, or a discount on the next leg. This is pricing, distinct from
            transfers.txt routing.
          </p>
        </div>

        <RailSubHeading count={fareTransferRules.length}>Fare Transfer Rules</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {fareTransferRules.map((rule, i) => (
            <button
              key={i}
              onClick={() => setSelectedIndex(i)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
            >
              <div className="font-medium truncate">{typeLabel(rule.fare_transfer_type)}</div>
              <div className="text-[11px] text-warm-gray mt-0.5 truncate">
                {[
                  rule.from_leg_group_id && `from: ${rule.from_leg_group_id}`,
                  rule.to_leg_group_id && `to: ${rule.to_leg_group_id}`,
                  rule.fare_product_id && `product: ${productLabel(rule.fare_product_id)}`,
                ].filter(Boolean).join(' · ') || 'any → any'}
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add Transfer Rule
        </button>
      </div>
    );
  }

  const idx = selectedIndex!;
  const productRequired = selected.fare_transfer_type === 1 || selected.fare_transfer_type === 2;

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray flex items-center gap-1.5 mb-1">
        <button onClick={() => setSelectedIndex(null)} className="hover:text-coral transition-colors">‹</button>
        <button onClick={() => setSelectedIndex(null)} className="hover:text-coral transition-colors">Transfer Rules</button>
        <span className="opacity-50">›</span>
        <span className="text-dark-brown font-semibold truncate">{typeLabel(selected.fare_transfer_type)}</span>
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          Transfer Rule
        </h2>
        <EditActions
          onDelete={() => { removeFareTransferRule(idx); setSelectedIndex(null); }}
          deleteTitle="Delete this transfer rule"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            From Leg Group
          </label>
          <select
            value={selected.from_leg_group_id ?? ''}
            onChange={(e) => updateFareTransferRule(idx, { from_leg_group_id: e.target.value || undefined })}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
          >
            <option value="">Any</option>
            {selected.from_leg_group_id && !legGroupIds.includes(selected.from_leg_group_id) && (
              <option value={selected.from_leg_group_id}>{selected.from_leg_group_id} (missing)</option>
            )}
            {legGroupIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            To Leg Group
          </label>
          <select
            value={selected.to_leg_group_id ?? ''}
            onChange={(e) => updateFareTransferRule(idx, { to_leg_group_id: e.target.value || undefined })}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
          >
            <option value="">Any</option>
            {selected.to_leg_group_id && !legGroupIds.includes(selected.to_leg_group_id) && (
              <option value={selected.to_leg_group_id}>{selected.to_leg_group_id} (missing)</option>
            )}
            {legGroupIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Transfer Type <span className="text-coral">*</span>
        </label>
        <select
          value={selected.fare_transfer_type}
          onChange={(e) => updateFareTransferRule(idx, { fare_transfer_type: Number(e.target.value) as 0 | 1 | 2 })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          {TRANSFER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Fare Product {productRequired && <span className="text-coral">*</span>}
        </label>
        <select
          value={selected.fare_product_id ?? ''}
          onChange={(e) => updateFareTransferRule(idx, { fare_product_id: e.target.value || undefined })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          <option value="">{productRequired ? 'Select a product…' : 'None'}</option>
          {selected.fare_product_id && !fareProducts.some((p) => p.fare_product_id === selected.fare_product_id) && (
            <option value={selected.fare_product_id}>{selected.fare_product_id} (missing)</option>
          )}
          {fareProducts.map((p) => (
            <option key={p.fare_product_id} value={p.fare_product_id}>
              {p.fare_product_name || p.fare_product_id}
            </option>
          ))}
        </select>
        {productRequired && !selected.fare_product_id && (
          <p className="text-amber-600 text-xs mt-1">This transfer type needs a fare product.</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FormField
          label="Transfer Count"
          type="number"
          value={selected.transfer_count != null ? String(selected.transfer_count) : ''}
          onChange={(v) => updateFareTransferRule(idx, { transfer_count: v === '' ? undefined : Number(v) })}
          placeholder="-1 = unlimited"
        />
        <FormField
          label="Duration Limit (s)"
          type="number"
          value={selected.duration_limit != null ? String(selected.duration_limit) : ''}
          onChange={(v) => updateFareTransferRule(idx, { duration_limit: v === '' ? undefined : Number(v) })}
          placeholder="seconds (optional)"
        />
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Duration Limit Type
        </label>
        <select
          value={selected.duration_limit_type ?? ''}
          onChange={(e) => updateFareTransferRule(idx, {
            duration_limit_type: e.target.value === '' ? undefined : (Number(e.target.value) as 0 | 1),
          })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          <option value="">Not set</option>
          {DURATION_TYPES.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
