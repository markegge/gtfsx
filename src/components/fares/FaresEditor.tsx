import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { EmptyState } from '../ui/EmptyState';
import { Badge } from '../ui/Badge';
import { generateId } from '../../services/idGenerator';
import type { FareAttribute } from '../../types/gtfs';

const FARE_TYPES = ['Regular', 'Reduced', 'Senior', 'Student', 'Free'] as const;

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
    addFareAttribute,
    updateFareAttribute,
    removeFareAttribute,
    addFareRule,
    removeFareRule,
  } = useStore();

  const [selectedFareId, setSelectedFareId] = useState<string | null>(null);

  const handleAddFare = () => {
    const fare: FareAttribute = {
      fare_id: generateId('fare'),
      price: '0.00',
      currency_type: 'USD',
      payment_method: 1,
      transfers: '',
    };
    addFareAttribute(fare);
    setSelectedFareId(fare.fare_id);
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

  if (fareAttributes.length === 0) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-300">
          <p className="text-amber-700 text-sm font-semibold">
            Fare information is strongly recommended for trip planning apps
          </p>
        </div>
        <EmptyState
          icon="💰"
          title="No fares defined"
          description="Add fare information so riders know how much trips cost."
          actionLabel="Add Fare"
          onAction={handleAddFare}
        />
      </div>
    );
  }

  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-3">Fares</h3>

      {/* Fare list */}
      <div className="space-y-1.5 mb-3">
        {fareAttributes.map((fare) => {
          const isSelected = fare.fare_id === selectedFareId;
          const ruleCount = fareRules.filter((r) => r.fare_id === fare.fare_id).length;
          return (
            <button
              key={fare.fare_id}
              onClick={() => setSelectedFareId(isSelected ? null : fare.fare_id)}
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

      {/* Edit form for selected fare */}
      {selectedFare && (
        <div>
          <div className="h-px bg-sand mb-4" />
          <h4 className="font-heading font-bold text-sm text-dark-brown mb-3">Edit Fare</h4>

          {/* Fare type label */}
          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Fare Type
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FARE_TYPES.map((type) => {
                // We encode fare type in fare_id prefix or a convention. Use a simple approach:
                // check if fare_id contains a type hint
                return (
                  <button
                    key={type}
                    onClick={() => {
                      updateFareAttribute(selectedFare.fare_id, {
                        fare_id: selectedFare.fare_id,
                        price: type === 'Free' ? '0.00' : selectedFare.price,
                      });
                    }}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors
                      ${type === 'Free' && selectedFare.price === '0.00'
                        ? 'bg-teal-light text-teal'
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

          {/* Fare rules — route associations */}
          <div className="h-px bg-sand my-4" />
          <h4 className="font-heading font-bold text-sm text-dark-brown mb-3">Route Rules</h4>

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

          {/* Delete */}
          <div className="h-px bg-sand my-4" />
          <button
            onClick={() => {
              removeFareAttribute(selectedFare.fare_id);
              setSelectedFareId(null);
            }}
            className="w-full py-2 rounded-lg border-2 border-red-300 text-red-500 text-sm font-semibold hover:bg-red-50 transition-colors"
          >
            Delete Fare
          </button>
        </div>
      )}
    </div>
  );
}
