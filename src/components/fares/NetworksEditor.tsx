import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Breadcrumb } from '../ui/Breadcrumb';
import { Badge } from '../ui/Badge';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareNetwork } from '../../types/gtfs';

/**
 * GTFS-Fares v2 Networks editor (networks.txt + route_networks.txt). A network
 * is a named grouping of routes for pricing; leg rules scope a fare to a
 * network. network_id is unique. Routes are assigned via route_networks.txt
 * (a route belongs to at most one network — assigning moves it), mirroring how
 * the Areas editor assigns stops.
 */
export function NetworksEditor() {
  const fareNetworks = useStore((s) => s.fareNetworks);
  const routeNetworks = useStore((s) => s.routeNetworks);
  const routes = useStore((s) => s.routes);
  const addFareNetwork = useStore((s) => s.addFareNetwork);
  const updateFareNetwork = useStore((s) => s.updateFareNetwork);
  const renameFareNetworkId = useStore((s) => s.renameFareNetworkId);
  const removeFareNetwork = useStore((s) => s.removeFareNetwork);
  const addRouteToNetwork = useStore((s) => s.addRouteToNetwork);
  const removeRouteFromNetwork = useStore((s) => s.removeRouteFromNetwork);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();
  const [routeFilter, setRouteFilter] = useState('');

  const selected = fareNetworks.find((n) => n.network_id === selectedId) ?? null;

  const routeCountByNetwork = useMemo(() => {
    const m = new Map<string, number>();
    for (const rn of routeNetworks) m.set(rn.network_id, (m.get(rn.network_id) ?? 0) + 1);
    return m;
  }, [routeNetworks]);

  // route_id → network_id, so we can show which (other) network claims a route.
  const networkByRoute = useMemo(() => {
    const m = new Map<string, string>();
    for (const rn of routeNetworks) m.set(rn.route_id, rn.network_id);
    return m;
  }, [routeNetworks]);

  const routeLabel = (routeId: string) => {
    const r = routes.find((x) => x.route_id === routeId);
    if (!r) return routeId;
    return r.route_short_name || r.route_long_name || routeId;
  };

  const open = (id: string | null) => {
    setSelectedId(id);
    const n = fareNetworks.find((x) => x.network_id === id);
    setIdDraft(n?.network_id ?? '');
    setIdError(undefined);
    setRouteFilter('');
  };

  const handleAdd = () => {
    const net: FareNetwork = { network_id: generateId('network') };
    addFareNetwork(net);
    open(net.network_id);
  };

  const commitId = () => {
    if (!selected) return;
    const next = idDraft.trim();
    if (!next) {
      setIdError('Network ID is required.');
      setIdDraft(selected.network_id);
      return;
    }
    if (next === selected.network_id) { setIdError(undefined); return; }
    if (fareNetworks.some((n) => n.network_id === next)) {
      setIdError(`Network ID "${next}" is already in use.`);
      return;
    }
    renameFareNetworkId(selected.network_id, next);
    setSelectedId(next);
    setIdError(undefined);
  };

  const assignedRouteIds = selected
    ? routeNetworks.filter((rn) => rn.network_id === selected.network_id).map((rn) => rn.route_id)
    : [];
  const assignedSet = new Set(assignedRouteIds);
  const filterLc = routeFilter.trim().toLowerCase();
  const availableRoutes = selected
    ? routes
        .filter((r) => !assignedSet.has(r.route_id))
        .filter((r) =>
          !filterLc ||
          (r.route_short_name || '').toLowerCase().includes(filterLc) ||
          (r.route_long_name || '').toLowerCase().includes(filterLc) ||
          r.route_id.toLowerCase().includes(filterLc),
        )
        .slice(0, 50)
    : [];

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            A <strong>network</strong> groups routes for fare pricing (networks.txt +
            route_networks.txt). Create a network, then assign its routes. Leg rules scope a fare to
            a network.
          </p>
        </div>

        <RailSubHeading count={fareNetworks.length}>Networks</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {fareNetworks.map((n) => {
            const count = routeCountByNetwork.get(n.network_id) ?? 0;
            return (
              <button
                key={n.network_id}
                onClick={() => open(n.network_id)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{n.network_name || n.network_id}</span>
                  <Badge variant={count > 0 ? 'info' : 'warning'}>
                    {count > 0 ? `${count} route${count > 1 ? 's' : ''}` : 'No routes'}
                  </Badge>
                </div>
                {n.network_name && (
                  <div className="text-[11px] text-warm-gray mt-0.5 font-mono">{n.network_id}</div>
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={handleAdd}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add Network
        </button>
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray mb-1">
        <Breadcrumb
          items={[
            { label: 'Networks', onClick: () => open(null) },
            { label: selected.network_name || selected.network_id, className: 'truncate' },
          ]}
        />
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          {selected.network_name || selected.network_id}
        </h2>
        <EditActions
          onDelete={() => { removeFareNetwork(selected.network_id); open(null); }}
          deleteTitle="Delete this network"
        />
      </div>

      <FormField
        label="Network ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder="network_id"
        required
        error={idError}
      />
      <FormField
        label="Network Name"
        value={selected.network_name ?? ''}
        onChange={(v) => updateFareNetwork(selected.network_id, { network_name: v || undefined })}
        placeholder="e.g. Local Bus (optional)"
      />
      {idDraft.trim() !== selected.network_id && (
        <button
          onClick={commitId}
          className="mb-4 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          Rename network to “{idDraft.trim() || '…'}”
        </button>
      )}

      <div className="h-px bg-sand my-4" />

      <RailSubHeading count={assignedRouteIds.length}>Routes in this network</RailSubHeading>

      {assignedRouteIds.length === 0 ? (
        <p className="text-[12px] text-warm-gray mb-3">
          No routes assigned yet. Add routes below to build this network.
        </p>
      ) : (
        <div className="space-y-1 mb-3">
          {assignedRouteIds.map((routeId) => (
            <div
              key={routeId}
              className="flex items-center justify-between px-3 py-2 bg-cream rounded-lg text-sm"
            >
              <span className="text-dark-brown truncate">{routeLabel(routeId)}</span>
              <button
                onClick={() => removeRouteFromNetwork(selected.network_id, routeId)}
                className="text-warm-gray hover:text-red-500 text-xs font-bold transition-colors shrink-0 ml-2"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        Add routes
      </label>
      <input
        type="text"
        value={routeFilter}
        onChange={(e) => setRouteFilter(e.target.value)}
        placeholder="Search routes by name or ID…"
        aria-label="Search routes by name or ID"
        className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white mb-2"
      />
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {availableRoutes.length === 0 ? (
          <p className="text-[12px] text-warm-gray px-1 py-2">
            {routes.length === 0
              ? 'No routes in this feed yet — add routes in the Routes panel first.'
              : 'No matching routes.'}
          </p>
        ) : (
          availableRoutes.map((route) => {
            const otherNet = networkByRoute.get(route.route_id);
            return (
              <button
                key={route.route_id}
                onClick={() => addRouteToNetwork(selected.network_id, route.route_id)}
                className="w-full flex items-center justify-between px-3 py-2 bg-white border border-sand rounded-lg text-sm hover:border-coral hover:text-coral transition-colors"
              >
                <span className="text-dark-brown truncate">
                  {route.route_short_name || route.route_long_name || route.route_id}
                  {otherNet && (
                    <span className="text-[10px] text-amber-600 ml-1">(moves from {otherNet})</span>
                  )}
                </span>
                <span className="text-coral text-xs font-bold shrink-0 ml-2">+ Add</span>
              </button>
            );
          })
        )}
        {selected && routes.filter((r) => !assignedSet.has(r.route_id)).length > availableRoutes.length && (
          <p className="text-[11px] text-warm-gray px-1 py-1">
            Showing first {availableRoutes.length}. Refine your search to see more.
          </p>
        )}
      </div>
    </div>
  );
}
