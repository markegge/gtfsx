import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Breadcrumb } from '../ui/Breadcrumb';
import { TabButton } from '../ui/Tabs';
import { Badge } from '../ui/Badge';
import { RailSubHeading, RailDivider } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareAttribute } from '../../types/gtfs';

const FARE_TYPES = ['Regular', 'Reduced', 'Senior', 'Student', 'Free'] as const;
type FareType = (typeof FARE_TYPES)[number];

// GTFS spec has no fare_type field; we encode the type as a fare_id prefix
// (e.g. "senior-fare1") so the choice survives export/import. "Regular" is
// the default and stays prefix-less so feeds without typed fares look natural.
const TYPE_PREFIXES: Record<Exclude<FareType, 'Regular'>, string> = {
  Reduced: 'reduced',
  Senior: 'senior',
  Student: 'student',
  Free: 'free',
};

function parseFareType(fareId: string): FareType {
  const first = fareId.split('-')[0]?.toLowerCase() ?? '';
  for (const [type, prefix] of Object.entries(TYPE_PREFIXES)) {
    if (first === prefix) return type as FareType;
  }
  return 'Regular';
}

function applyTypePrefix(fareId: string, newType: FareType): string {
  // Strip any existing recognized prefix first.
  let suffix = fareId;
  for (const prefix of Object.values(TYPE_PREFIXES)) {
    if (fareId.startsWith(prefix + '-')) {
      suffix = fareId.slice(prefix.length + 1);
      break;
    }
  }
  if (newType === 'Regular') return suffix;
  return `${TYPE_PREFIXES[newType]}-${suffix}`;
}

function ensureUniqueFareId(base: string, existing: readonly string[], self: string): string {
  if (base === self) return base;
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const cand = `${base}-${n}`;
    if (!existing.includes(cand)) return cand;
  }
}

const PAYMENT_METHODS: { value: 0 | 1; label: string }[] = [
  { value: 0, label: 'On board' },
  { value: 1, label: 'Before boarding' },
];

const TRANSFER_OPTIONS: { value: 0 | 1 | 2 | ''; label: string }[] = [
  { value: 0, label: 'No transfers' },
  { value: 1, label: '1 transfer' },
  { value: 2, label: '2 transfers' },
  { value: '', label: 'Unlimited' },
];

export function FaresEditor() {
  const {
    fareAttributes,
    fareRules,
    routes,
    stops,
    addFareAttribute,
    updateFareAttribute,
    renameFareId,
    removeFareAttribute,
    duplicateFareAttribute,
    addFareRule,
    removeFareRule,
    removeFareRuleAt,
  } = useStore();

  // Distinct non-empty zone_ids used by any stop. Origin/destination fare
  // rules reference these IDs (per the GTFS-Fares v1 spec).
  const zoneIds: string[] = [];
  const seenZones = new Set<string>();
  for (const s of stops) {
    if (s.zone_id && !seenZones.has(s.zone_id)) {
      seenZones.add(s.zone_id);
      zoneIds.push(s.zone_id);
    }
  }
  zoneIds.sort();

  const [selectedFareId, setSelectedFareId] = useState<string | null>(null);
  const [fareTab, setFareTab] = useState<'details' | 'rules'>('details');
  const [pendingOrigin, setPendingOrigin] = useState('');
  const [pendingDest, setPendingDest] = useState('');

  // Open a fare on its Edit Fare tab (used by the list and by + Add Fare).
  const openFare = (id: string | null) => {
    setSelectedFareId(id);
    setFareTab('details');
  };

  const handleAddFare = () => {
    const fare: FareAttribute = {
      fare_id: generateId('fare'),
      price: '0.00',
      currency_type: 'USD',
      payment_method: 1,
      transfers: '',
    };
    addFareAttribute(fare);
    openFare(fare.fare_id);
  };

  const selectedFare = fareAttributes.find((f) => f.fare_id === selectedFareId);

  const fareRulesForSelected = fareRules.filter((r) => r.fare_id === selectedFareId);
  const hasAllRoutes = fareRulesForSelected.length === 0;

  const handleAddRouteRule = (routeId: string) => {
    if (!selectedFareId) return;
    addFareRule({ fare_id: selectedFareId, route_id: routeId });
  };

  const handleRemoveRouteRule = (routeId: string) => {
    if (!selectedFareId) return;
    removeFareRule(selectedFareId, routeId);
  };

  const handleSetAllRoutes = () => {
    if (!selectedFareId) return;
    // Remove all route-specific rules for this fare
    const currentRules = fareRules.filter((r) => r.fare_id === selectedFareId);
    for (const rule of currentRules) {
      removeFareRule(selectedFareId, rule.route_id);
    }
  };

  return (
    <div>
      {!selectedFare && (
       <>
      {fareAttributes.length === 0 && (
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-300">
          <p className="text-amber-700 text-sm font-semibold">
            Fare information is strongly recommended for trip planning apps
          </p>
        </div>
      )}

      <RailSubHeading count={fareAttributes.length}>Fixed Route Fares</RailSubHeading>

      {/* Fare list */}
      <div className="space-y-1.5 mb-3">
        {fareAttributes.map((fare) => {
          const isSelected = fare.fare_id === selectedFareId;
          const ruleCount = fareRules.filter((r) => r.fare_id === fare.fare_id).length;
          return (
            <button
              key={fare.fare_id}
              onClick={() => openFare(isSelected ? null : fare.fare_id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors
                ${isSelected
                  ? 'bg-coral-light text-coral font-semibold'
                  : 'bg-cream text-dark-brown hover:bg-sand'
                }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {fare.currency_type} {fare.price}
                </span>
                <Badge variant={ruleCount > 0 ? 'info' : 'success'}>
                  {ruleCount > 0 ? `${ruleCount} route${ruleCount > 1 ? 's' : ''}` : 'All routes'}
                </Badge>
              </div>
              <div className="text-[11px] text-warm-gray mt-0.5">
                {fare.transfers === '' ? 'Unlimited transfers' : `${fare.transfers} transfer${fare.transfers !== 1 ? 's' : ''}`}
                {' · '}
                {fare.payment_method === 0 ? 'Pay on board' : 'Pay before boarding'}
              </div>
            </button>
          );
        })}
      </div>

      <button
        onClick={handleAddFare}
        className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors mb-4"
      >
        + Add Fare
      </button>
       </>
      )}

      {/* Fare detail — breadcrumb + tabbed sub-panel (replaces the list, like
          the route/stop editors) */}
      {selectedFare && (
        <div>
          {/* Breadcrumb */}
          <nav className="text-[13px] text-warm-gray mb-1">
            <Breadcrumb
              items={[
                { label: 'Fares', onClick: () => setSelectedFareId(null) },
                { label: `${selectedFare.currency_type} ${selectedFare.price}`, className: 'truncate' },
              ]}
            />
          </nav>

          {/* Title + actions */}
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
              {selectedFare.currency_type} {selectedFare.price}
            </h2>
            <EditActions
              onDuplicate={() => {
                const newId = duplicateFareAttribute(selectedFare.fare_id);
                if (newId) openFare(newId);
              }}
              onDelete={() => {
                removeFareAttribute(selectedFare.fare_id);
                setSelectedFareId(null);
              }}
              duplicateTitle="Duplicate this fare"
              deleteTitle="Delete this fare"
            />
          </div>

          {/* Sub-tabs */}
          <div className="flex gap-1 mb-4 border-b border-sand">
            {(['details', 'rules'] as const).map((t) => (
              <TabButton key={t} active={fareTab === t} onClick={() => setFareTab(t)}>
                {t === 'details' ? 'Edit Fare' : 'Route Rules'}
              </TabButton>
            ))}
          </div>

          {fareTab === 'details' && (
           <>
          {/* Fare type — encoded as a fare_id prefix (see TYPE_PREFIXES). */}
          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Fare Type
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FARE_TYPES.map((type) => {
                const currentType = parseFareType(selectedFare.fare_id);
                const isSelected = type === currentType;
                return (
                  <button
                    key={type}
                    onClick={() => {
                      if (isSelected) return;
                      const desired = applyTypePrefix(selectedFare.fare_id, type);
                      const otherIds = fareAttributes.map((f) => f.fare_id);
                      const newId = ensureUniqueFareId(desired, otherIds, selectedFare.fare_id);
                      if (newId !== selectedFare.fare_id) {
                        renameFareId(selectedFare.fare_id, newId);
                        setSelectedFareId(newId);
                      }
                      if (type === 'Free' && selectedFare.price !== '0.00') {
                        updateFareAttribute(newId, { price: '0.00' });
                      }
                    }}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors
                      ${isSelected
                        ? 'bg-coral-light text-coral'
                        : 'bg-cream text-warm-gray hover:bg-sand'
                      }`}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          <FormField
            label="Price"
            value={selectedFare.price}
            onChange={(v) => updateFareAttribute(selectedFare.fare_id, { price: v })}
            placeholder="0.00"
            required
          />

          <FormField
            label="Currency"
            value={selectedFare.currency_type}
            onChange={(v) => updateFareAttribute(selectedFare.fare_id, { currency_type: v })}
            placeholder="USD"
            required
          />

          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Payment Method <span className="text-coral">*</span>
            </label>
            <select
              value={selectedFare.payment_method}
              onChange={(e) => updateFareAttribute(selectedFare.fare_id, { payment_method: Number(e.target.value) as 0 | 1 })}
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
            >
              {PAYMENT_METHODS.map((pm) => (
                <option key={pm.value} value={pm.value}>{pm.label}</option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Transfers
            </label>
            <select
              value={selectedFare.transfers}
              onChange={(e) => {
                const val = e.target.value;
                updateFareAttribute(selectedFare.fare_id, {
                  transfers: val === '' ? '' : (Number(val) as 0 | 1 | 2),
                });
              }}
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
            >
              {TRANSFER_OPTIONS.map((opt) => (
                <option key={String(opt.value)} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <FormField
            label="Transfer Duration (seconds)"
            value={selectedFare.transfer_duration != null ? String(selectedFare.transfer_duration) : ''}
            onChange={(v) => updateFareAttribute(selectedFare.fare_id, {
              transfer_duration: v ? Number(v) : undefined,
            })}
            placeholder="e.g., 5400"
            type="number"
          />

          </>
          )}

          {fareTab === 'rules' && (
           <>
          {/* Fare rules — route associations */}
          <div className="mb-3">
            <button
              onClick={handleSetAllRoutes}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors
                ${hasAllRoutes
                  ? 'bg-teal-light text-teal'
                  : 'bg-cream text-warm-gray hover:bg-sand'
                }`}
            >
              All routes
            </button>
          </div>

          {!hasAllRoutes && (
            <div className="space-y-1 mb-3">
              {fareRulesForSelected.map((rule) => {
                const route = routes.find((r) => r.route_id === rule.route_id);
                return (
                  <div
                    key={rule.route_id}
                    className="flex items-center justify-between px-3 py-2 bg-cream rounded-lg text-sm"
                  >
                    <span className="text-dark-brown">
                      {route ? (route.route_short_name || route.route_long_name) : rule.route_id}
                    </span>
                    <button
                      onClick={() => handleRemoveRouteRule(rule.route_id!)}
                      className="text-warm-gray hover:text-red-500 text-xs font-bold transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {routes.length > 0 && (
            <div className="mb-3">
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                Add Route
              </label>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) handleAddRouteRule(e.target.value);
                }}
                className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
              >
                <option value="">Select a route...</option>
                {routes
                  .filter((r) => !fareRulesForSelected.some((rule) => rule.route_id === r.route_id))
                  .map((r) => (
                    <option key={r.route_id} value={r.route_id}>
                      {r.route_short_name || r.route_long_name || r.route_id}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {/* Origin / Destination zone rules (GTFS-Fares v1). For
              point-to-point pricing — used by ferries, intercity rail. */}
          <RailDivider />
          <RailSubHeading>Zone-pair Rules</RailSubHeading>

          {zoneIds.length === 0 ? (
            <div className="mb-3 p-3 rounded-lg bg-cream text-[12px] text-warm-gray">
              Set a Fare Zone ID on at least one stop (in the Stops panel) to
              create origin / destination price rules. Use this when the fare
              depends on which stops a rider boards and alights at, not on
              the route they take.
            </div>
          ) : (
            <>
              {(() => {
                const odRules = fareRules
                  .map((r, idx) => ({ rule: r, idx }))
                  .filter(({ rule }) =>
                    rule.fare_id === selectedFare.fare_id &&
                    (rule.origin_id || rule.destination_id),
                  );
                return (
                  <div className="space-y-1 mb-3">
                    {odRules.length === 0 && (
                      <p className="text-[12px] text-warm-gray">
                        No zone-pair rules yet — this fare applies route-wide.
                      </p>
                    )}
                    {odRules.map(({ rule, idx }) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between px-3 py-2 bg-cream rounded-lg text-sm"
                      >
                        <span className="text-dark-brown font-mono text-[12px]">
                          {rule.origin_id || '*'} → {rule.destination_id || '*'}
                        </span>
                        <button
                          onClick={() => removeFareRuleAt(idx)}
                          className="text-warm-gray hover:text-red-500 text-xs font-bold transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}

              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-3">
                <select
                  value={pendingOrigin}
                  onChange={(e) => setPendingOrigin(e.target.value)}
                  className="px-2 py-1.5 border-2 border-sand rounded-md text-xs bg-cream"
                >
                  <option value="">From zone…</option>
                  {zoneIds.map((z) => (
                    <option key={z} value={z}>{z}</option>
                  ))}
                </select>
                <select
                  value={pendingDest}
                  onChange={(e) => setPendingDest(e.target.value)}
                  className="px-2 py-1.5 border-2 border-sand rounded-md text-xs bg-cream"
                >
                  <option value="">To zone…</option>
                  {zoneIds.map((z) => (
                    <option key={z} value={z}>{z}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    if (!pendingOrigin && !pendingDest) return;
                    addFareRule({
                      fare_id: selectedFare.fare_id,
                      origin_id: pendingOrigin || undefined,
                      destination_id: pendingDest || undefined,
                    });
                    setPendingOrigin('');
                    setPendingDest('');
                  }}
                  disabled={!pendingOrigin && !pendingDest}
                  className="px-3 py-1.5 bg-coral text-white rounded-md text-xs font-bold hover:bg-[#d4603a] disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </>
          )}
          </>
          )}

        </div>
      )}
    </div>
  );
}
