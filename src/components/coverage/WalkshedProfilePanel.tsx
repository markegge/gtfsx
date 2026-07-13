import { type ReactNode } from 'react';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { RouteScopeNote } from '../ui/RouteScopeNote';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';
import { downloadBlob } from '../../services/gtfsExport';
import {
  buildProfileCsvRows,
  bufferLabel,
  type WalkshedProfile,
  type WalkshedProfileResult,
} from '../../services/walkshedProfile';
import { useWalkshedProfile } from './useWalkshedProfile';
import { WalkshedProfileTable, WalkshedProfileNotes } from './WalkshedProfileTable';

/**
 * Walkshed demographic profile — WHO is within a walk of a stop, and of a route.
 *
 * Counts only. This panel does not, and must not, predict ridership: GTFS·X
 * deliberately refuses to synthesise boardings (docs/REQUIREMENTS.md), so no
 * coefficient, elasticity, or "expected riders" belongs anywhere in here.
 *
 * Gated on `analysis_basic` (Planner+), the same key the rest of the coverage /
 * cost analysis uses. No new FeatureKey — the plan catalogs in
 * worker/billing/plans.ts and components/billing/planConfig.ts are hand-mirrored
 * and adding a key means editing both.
 */

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * The one thing this whole feature rests on, said out loud wherever a
 * route/system number is shown.
 */
function UnionNote({ profile }: { profile: WalkshedProfile }) {
  return (
    <p className="text-[10px] leading-relaxed text-warm-gray">
      <span className="font-semibold text-dark-brown">Counted once.</span> Neighbouring stops'
      walksheds overlap heavily, so this is the <span className="font-semibold">union</span> of{' '}
      {fmt(profile.stopCount)} {profile.stopCount === 1 ? 'walkshed' : 'walksheds'}, not the sum of
      them: each of the {fmt(profile.blocksCounted)} census blocks contributes exactly once, however
      many stops it is near. Adding the per-stop numbers together would count the same households
      several times over.
    </p>
  );
}

/**
 * Shared shell: run button, spinner, error, and the "not run yet" prompt.
 * Renders `children(profiles)` only once a result exists. The fetch is always
 * an explicit user action — never fired from render.
 */
function ProfileGate({
  children,
  intro,
}: {
  children: (profiles: WalkshedProfileResult) => ReactNode;
  intro?: ReactNode;
}) {
  const { profiles, isFetching, error, run, stops, visibleRouteCount, totalRouteCount } =
    useWalkshedProfile();

  return (
    <div className="space-y-3">
      <RouteScopeNote visible={visibleRouteCount} total={totalRouteCount} />
      {intro}

      <button
        onClick={run}
        disabled={isFetching || stops.length === 0}
        className="w-full rounded-lg bg-teal px-4 py-2.5 font-heading text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isFetching
          ? 'Counting census blocks…'
          : profiles
            ? 'Re-run profile'
            : 'Run demographic profile'}
      </button>

      {isFetching && (
        <div className="py-4 text-center">
          <div className="mb-2 inline-block h-6 w-6 animate-spin rounded-full border-2 border-teal border-t-transparent" />
          <p className="text-xs text-warm-gray">
            Loading the census-block layer for this feed (one fetch for the whole feed)…
          </p>
        </div>
      )}

      {error && !isFetching && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-700">Couldn't build the profile</p>
          <p className="mt-1 text-xs text-red-600">{error}</p>
        </div>
      )}

      {profiles && !isFetching && children(profiles)}

      {!profiles && !isFetching && !error && (
        <p className="text-[11px] italic text-warm-gray">
          Not run yet. The profile loads the census-block layer once for the whole feed, then
          tabulates every stop and route from memory.
        </p>
      )}
    </div>
  );
}

/* ────────────────────── system + per-route (Coverage section) ────────────────────── */

/**
 * Feed-level profile: the system union, then one union profile per route.
 * Lives at the bottom of the Coverage panel.
 */
export function WalkshedProfilePanel() {
  const plan = useEditorPlan();

  return (
    <div className="space-y-2 border-t border-sand pt-4">
      <h3 className="font-heading text-sm font-bold text-dark-brown">
        Walkshed demographic profile
        <span className="ml-1.5 rounded border border-teal/30 bg-teal-light px-1 text-[9px] font-bold uppercase tracking-wide text-teal">
          census block · exact
        </span>
      </h3>
      <PaywallOverlay feature="analysis_basic" currentPlan={plan} preview>
        <WalkshedProfileBody />
      </PaywallOverlay>
    </div>
  );
}

function WalkshedProfileBody() {
  const routes = useStore((s) => s.routes);

  return (
    <ProfileGate
      intro={
        <p className="text-xs text-warm-gray">
          Who lives and works within a walk of your stops, counted from individual census blocks (not
          the smeared block-group estimate above). Route numbers are the{' '}
          <span className="font-semibold text-dark-brown">union</span> of their stops' walksheds, so
          nobody is counted twice. This is a count of people, not a ridership forecast.
        </p>
      }
    >
      {(profiles) => (
        <div className="space-y-4">
          {/* System */}
          <div className="space-y-2 rounded-lg bg-teal-light p-3">
            <div className="flex items-center gap-2">
              <h4 className="min-w-0 flex-1 font-heading text-sm font-bold text-teal">
                Whole system ({bufferLabel(profiles.system.bufferMiles)} walk)
              </h4>
              <button
                onClick={() =>
                  downloadBlob(
                    new Blob([Papa.unparse(buildProfileCsvRows(profiles, routes))], {
                      type: 'text/csv;charset=utf-8;',
                    }),
                    'walkshed-demographic-profile.csv',
                  )
                }
                className="whitespace-nowrap text-[11px] font-semibold text-teal hover:underline"
              >
                ↓ Download CSV
              </button>
            </div>
            <WalkshedProfileTable profile={profiles.system} />
            <UnionNote profile={profiles.system} />
          </div>

          <WalkshedProfileNotes profile={profiles.system} />

          {/* Per route */}
          <div className="space-y-2">
            <h4 className="font-heading text-sm font-bold text-dark-brown">By route</h4>
            <p className="text-[10px] text-warm-gray">
              Each route's own union. Routes overlap each other too, so these do not add up to the
              system number either.
            </p>
            {routes.map((r) => {
              const p = profiles.byRoute[r.route_id];
              if (!p) return null;
              return (
                <RouteProfileRow
                  key={r.route_id}
                  name={r.route_short_name || r.route_long_name || r.route_id}
                  color={r.route_color}
                  profile={p}
                />
              );
            })}
          </div>
        </div>
      )}
    </ProfileGate>
  );
}

function RouteProfileRow({
  name,
  color,
  profile,
}: {
  name: string;
  color: string;
  profile: WalkshedProfile;
}) {
  return (
    <div className="space-y-1.5 rounded-lg bg-cream p-2.5">
      <div className="flex items-center gap-2">
        <div
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: `#${color}` }}
        />
        <span className="truncate font-heading text-sm font-bold text-dark-brown">{name}</span>
        <span className="ml-auto whitespace-nowrap text-[11px] text-warm-gray">
          {bufferLabel(profile.bufferMiles)} · {fmt(profile.stopCount)} stops
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1 text-center">
        <Cell label="Residents" value={profile.counts.population} />
        <Cell label="HH" value={profile.counts.households} />
        <Cell label="Jobs" value={profile.counts.jobs} title="Workplace-based (LODES)" />
        <Cell
          label="Zero-veh HH"
          value={profile.counts.zeroVehicleHouseholds}
          title="Occupied households with no vehicle"
        />
      </div>
    </div>
  );
}

function Cell({ label, value, title }: { label: string; value: number; title?: string }) {
  return (
    <div title={title}>
      <p className="font-heading text-sm font-bold tabular-nums text-dark-brown">{fmt(value)}</p>
      <p className="text-[10px] text-warm-gray">{label}</p>
    </div>
  );
}

/* ────────────────────── route detail tab ────────────────────── */

/**
 * The Coverage tab of the route detail sub-panel: this route's walkshed profile
 * (union across its stops) plus the top overlapping stops, so a planner can see
 * where the people actually are along the line.
 */
export function RouteWalkshedProfileTab() {
  const plan = useEditorPlan();
  const routeId = useStore((s) => s.editingRouteId);
  const route = useStore((s) => s.routes.find((r) => r.route_id === s.editingRouteId) ?? null);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const setEditingStopId = useStore((s) => s.setEditingStopId);

  if (!route || !routeId) return null;

  return (
    <PaywallOverlay feature="analysis_basic" currentPlan={plan} preview>
      <ProfileGate
        intro={
          <p className="text-xs text-warm-gray">
            Who lives and works within a walk of{' '}
            <span className="font-semibold text-dark-brown">
              {route.route_short_name || route.route_long_name || routeId}
            </span>
            , counted from individual census blocks. This is the{' '}
            <span className="font-semibold text-dark-brown">union</span> of the route's stop
            walksheds — each block counted once — not the sum of its stops. It counts people; it does
            not forecast ridership.
          </p>
        }
      >
        {(profiles) => {
          const profile = profiles.byRoute[routeId];
          if (!profile) {
            return (
              <p className="text-xs italic text-warm-gray">
                This route has no stops to profile.
              </p>
            );
          }
          // Stops on this route, biggest walkshed population first — a "where
          // are the people" ranking, not a ranking of anything predictive.
          const ranked = [...new Set(
            routeStops.filter((rs) => rs.route_id === routeId).map((rs) => rs.stop_id),
          )]
            .map((id) => ({ stop: stops.find((s) => s.stop_id === id), p: profiles.byStop[id] }))
            .filter((x): x is { stop: (typeof stops)[number]; p: WalkshedProfile } => !!x.stop && !!x.p)
            .sort((a, b) => b.p.counts.population - a.p.counts.population);

          const perStopSum = ranked.reduce((a, x) => a + x.p.counts.population, 0);

          return (
            <div className="space-y-4">
              <div className="space-y-2 rounded-lg bg-teal-light p-3">
                <h4 className="font-heading text-sm font-bold text-teal">
                  Route walkshed ({bufferLabel(profile.bufferMiles)} walk)
                </h4>
                <WalkshedProfileTable profile={profile} />
                <UnionNote profile={profile} />
                {perStopSum > profile.counts.population && (
                  <p className="text-[10px] leading-relaxed text-teal">
                    For scale: naively summing this route's {fmt(profile.stopCount)} stops would give{' '}
                    <span className="font-semibold">{fmt(perStopSum)}</span> residents — {' '}
                    <span className="font-semibold">
                      {(perStopSum / Math.max(1, profile.counts.population)).toFixed(1)}×
                    </span>{' '}
                    the true figure of {fmt(profile.counts.population)}, because overlapping
                    walksheds would count the same people again at every nearby stop.
                  </p>
                )}
              </div>

              <WalkshedProfileNotes profile={profile} />

              <div className="space-y-1">
                <h4 className="font-heading text-sm font-bold text-dark-brown">
                  Stops, by residents in walkshed
                </h4>
                <p className="text-[10px] text-warm-gray">
                  Per-stop walksheds overlap — these are for comparing stops with each other, not for
                  adding up.
                </p>
                <div className="max-h-64 space-y-0.5 overflow-y-auto">
                  {ranked.map(({ stop, p }) => (
                    <button
                      key={stop.stop_id}
                      onClick={() => setEditingStopId(stop.stop_id)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-cream"
                      title={`Open ${stop.stop_name || stop.stop_id}`}
                    >
                      <span className="min-w-0 flex-1 truncate text-left text-dark-brown">
                        {stop.stop_name || stop.stop_id}
                      </span>
                      <span className="tabular-nums text-warm-gray">
                        {fmt(p.counts.population)}
                      </span>
                      <span className="w-14 text-right tabular-nums text-warm-gray">
                        {fmt(p.counts.jobs)} jobs
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        }}
      </ProfileGate>
    </PaywallOverlay>
  );
}

/* ────────────────────── stop detail section ────────────────────── */

/**
 * The stop sub-panel's profile. Reads the SAME feed-wide result the route tab
 * reads — opening ten stops in a row costs zero extra fetches.
 */
export function StopWalkshedProfile({ stopId }: { stopId: string }) {
  return (
    <ProfileGate
      intro={
        <p className="text-xs text-warm-gray">
          Who lives and works within a walk of this stop, counted from the individual census blocks
          whose center falls inside the buffer. A count of people, not a ridership forecast.
        </p>
      }
    >
      {(profiles) => {
        const profile = profiles.byStop[stopId];
        if (!profile) {
          return (
            <p className="text-xs italic text-warm-gray">
              This stop wasn't in the last profile run — re-run it.
            </p>
          );
        }
        return (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h4 className="font-heading text-sm font-bold text-dark-brown">
                Inside a {bufferLabel(profile.bufferMiles)} walk
              </h4>
              <span className="text-[10px] text-warm-gray">
                {fmt(profile.blocksCounted)} census blocks
              </span>
            </div>
            <WalkshedProfileTable profile={profile} />
            <WalkshedProfileNotes profile={profile} />
          </div>
        );
      }}
    </ProfileGate>
  );
}
