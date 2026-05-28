import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { downloadBlob } from '../../services/gtfsExport';
import { secondsToGtfsTime, formatTimeShort } from '../../utils/time';
import {
  computeStopSpacing,
  computeBalancingCandidates,
  computeServiceIntensity,
  computeAccessibilityAudit,
  representativeDay,
  DEFAULT_SPACING_BENCHMARKS,
  type FeedSlice,
} from '../../services/stopAnalysis';

type MapOverlayKind = 'balancing' | 'intensity' | 'accessibility' | null;

function fmtFt(ft: number | null): string {
  if (ft == null) return '—';
  return `${Math.round(ft).toLocaleString()} ft`;
}
function fmtMin(min: number | null): string {
  if (min == null) return '—';
  return `${Math.round(min)} min`;
}
function fmtHours(h: number | null): string {
  if (h == null) return '—';
  return `${h.toFixed(1)} h`;
}
function depLabel(sec: number | null): string {
  return sec == null ? '—' : formatTimeShort(secondsToGtfsTime(sec));
}
function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  downloadBlob(new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8;' }), filename);
}

/* ── reusable bits ── */

function Section({
  title, subtitle, open, onToggle, children,
}: {
  title: string; subtitle?: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="border border-sand rounded-xl overflow-hidden bg-white">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-cream transition-colors"
      >
        <span className="text-warm-gray text-xs w-3">{open ? '▾' : '▸'}</span>
        <span className="flex-1 min-w-0">
          <span className="font-heading font-bold text-sm text-dark-brown">{title}</span>
          {subtitle && <span className="block text-[11px] text-warm-gray truncate">{subtitle}</span>}
        </span>
      </button>
      {open && <div className="px-3 pb-3 pt-1 space-y-3">{children}</div>}
    </div>
  );
}

function MapToggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-warm-gray cursor-pointer">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="accent-coral" />
      {label}
    </label>
  );
}

function CsvButton({ onClick, label = 'Download CSV' }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-semibold text-teal hover:underline"
    >
      ↓ {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-heading font-bold text-sm text-dark-brown tabular-nums">{value}</div>
      <div className="text-[10px] text-warm-gray uppercase tracking-wide">{label}</div>
    </div>
  );
}

function NumField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="flex-1 min-w-0">
      <span className="block text-[10px] text-warm-gray mb-0.5">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) onChange(n); }}
        className="w-full px-2 py-1 border border-sand rounded-md text-xs bg-cream focus:outline-none focus:border-coral tabular-nums"
      />
    </label>
  );
}

/* ── histogram ── */

function SpacingHistogram({
  bins, tooCloseFt, hardMaxFt, targetMinFt, targetMaxFt,
}: {
  bins: { lo: number; hi: number; count: number }[];
  tooCloseFt: number; hardMaxFt: number; targetMinFt: number; targetMaxFt: number;
}) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div>
      <div className="flex items-end gap-px h-20 bg-cream rounded-md p-1">
        {bins.map((b) => {
          const mid = (b.lo + b.hi) / 2;
          const color =
            mid < tooCloseFt ? '#E07A5F' :          // too close — coral/red
            mid > hardMaxFt ? '#C0612F' :            // too far — amber/brown
            mid >= targetMinFt && mid <= targetMaxFt ? '#3E7C8B' : // in target — teal
            '#C9BDB1';                               // ok-ish — sand
          return (
            <div
              key={b.lo}
              className="flex-1 rounded-t-sm"
              style={{ height: `${(b.count / max) * 100}%`, backgroundColor: color, minHeight: b.count ? 2 : 0 }}
              title={`${b.lo}–${b.hi} ft: ${b.count}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-warm-gray mt-0.5 px-1">
        <span>0</span><span>1,500 ft</span><span>3,000+ ft</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-warm-gray">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#E07A5F' }} />Too close</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#3E7C8B' }} />Target</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: '#C0612F' }} />Too far</span>
      </div>
    </div>
  );
}

/* ── main panel ── */

export function StopAnalysisPanel() {
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);
  const selectRoute = useStore((s) => s.selectRoute);
  const setStopAnalysisOverlay = useStore((s) => s.setStopAnalysisOverlay);
  const setBottomPanelOpen = useStore((s) => s.setBottomPanelOpen);
  const setBottomPanelTab = useStore((s) => s.setBottomPanelTab);

  const feed: FeedSlice = useMemo(
    () => ({ stops, routes, routeStops, trips, stopTimes, calendars, calendarDates }),
    [stops, routes, routeStops, trips, stopTimes, calendars, calendarDates],
  );

  // ── config (all defaults UI-editable, never hardcoded in business logic) ──
  const [tooCloseFt, setTooCloseFt] = useState(DEFAULT_SPACING_BENCHMARKS.tooCloseFt);
  const [hardMaxFt, setHardMaxFt] = useState(DEFAULT_SPACING_BENCHMARKS.hardMaxFt);
  const [balanceThresholdFt, setBalanceThresholdFt] = useState(600);
  const [dwellSeconds, setDwellSeconds] = useState(18);
  const [serviceOverride, setServiceOverride] = useState<string>(''); // '' = auto / representative

  const repDay = useMemo(() => representativeDay(feed), [feed]);
  const activeServiceIds = useMemo(
    () => (serviceOverride ? new Set([serviceOverride]) : repDay.serviceIds),
    [serviceOverride, repDay],
  );

  const spacing = useMemo(
    () => computeStopSpacing(feed, { ...DEFAULT_SPACING_BENCHMARKS, tooCloseFt, hardMaxFt }),
    [feed, tooCloseFt, hardMaxFt],
  );
  const balancing = useMemo(
    () => computeBalancingCandidates(feed, { thresholdFt: balanceThresholdFt, dwellSeconds, serviceIds: activeServiceIds }),
    [feed, balanceThresholdFt, dwellSeconds, activeServiceIds],
  );
  const intensity = useMemo(
    () => computeServiceIntensity(feed, { serviceIds: activeServiceIds }),
    [feed, activeServiceIds],
  );
  const accessibility = useMemo(() => computeAccessibilityAudit(feed), [feed]);

  // ── open/close + map overlay state ──
  const [open, setOpen] = useState<Record<string, boolean>>({ spacing: true });
  const [mapOverlay, setMapOverlay] = useState<MapOverlayKind>(null);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const setOverlay = (kind: Exclude<MapOverlayKind, null>, on: boolean) =>
    setMapOverlay((cur) => (on ? kind : cur === kind ? null : cur));

  useEffect(() => {
    if (mapOverlay === 'balancing') {
      setStopAnalysisOverlay({ kind: 'balancing', stopIds: balancing.removalStopIds });
    } else if (mapOverlay === 'accessibility') {
      setStopAnalysisOverlay({ kind: 'accessibility', stopIds: accessibility.gapStopIds });
    } else if (mapOverlay === 'intensity') {
      const t: Record<string, number> = {};
      let mx = 0;
      for (const s of intensity) { t[s.stopId] = s.tripsPerDay; if (s.tripsPerDay > mx) mx = s.tripsPerDay; }
      setStopAnalysisOverlay({ kind: 'intensity', trips: t, maxTrips: mx });
    } else {
      setStopAnalysisOverlay(null);
    }
  }, [mapOverlay, balancing, accessibility, intensity, setStopAnalysisOverlay]);

  // Clear the overlay when the panel unmounts (section change already clears it
  // in the store, but unmount via rail-close needs its own cleanup).
  useEffect(() => () => setStopAnalysisOverlay(null), [setStopAnalysisOverlay]);

  if (stops.length === 0) {
    return (
      <EmptyState
        icon="📊"
        title="No Stops Yet"
        description="Add stops and build some trips before running stop-level diagnostics."
      />
    );
  }

  const vehHoursSaved = balancing.totalSavingsSecPerDay / 3600;

  return (
    <div className="space-y-3">
      <p className="text-xs text-warm-gray">
        Industry-standard stop diagnostics computed from this feed. Spacing uses straight-line
        distance between stops; service metrics use the {serviceOverride ? 'selected' : 'busiest'}{' '}
        service day{serviceOverride ? '' : ` (${repDay.label})`}.
      </p>

      {/* ── Feature 1: Stop spacing ── */}
      <Section
        title="Stop spacing distribution"
        subtitle={`median ${fmtFt(spacing.medianFt)} · ${spacing.pairCount.toLocaleString()} segments`}
        open={!!open.spacing}
        onToggle={() => toggle('spacing')}
      >
        <SpacingHistogram
          bins={spacing.histogram}
          tooCloseFt={tooCloseFt}
          hardMaxFt={hardMaxFt}
          targetMinFt={DEFAULT_SPACING_BENCHMARKS.urbanMinFt}
          targetMaxFt={DEFAULT_SPACING_BENCHMARKS.suburbanMaxFt}
        />
        <div className="grid grid-cols-4 gap-2">
          <Stat label="Median" value={fmtFt(spacing.medianFt)} />
          <Stat label="Mean" value={fmtFt(spacing.meanFt)} />
          <Stat label="p10" value={fmtFt(spacing.p10Ft)} />
          <Stat label="p90" value={fmtFt(spacing.p90Ft)} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span className="text-[#E07A5F] font-semibold">{spacing.tooCloseCount} too close</span>
          <span className="text-teal font-semibold">{spacing.inTargetCount} in target</span>
          <span className="text-[#C0612F] font-semibold">{spacing.aboveMaxCount} too far</span>
        </div>
        <div className="flex gap-2">
          <NumField label="Too-close (ft)" value={tooCloseFt} onChange={setTooCloseFt} step={50} />
          <NumField label="Hard max (ft)" value={hardMaxFt} onChange={setHardMaxFt} step={100} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">By route (tightest first)</span>
            <CsvButton onClick={() => exportCsv('stop-spacing-by-route.csv', spacing.perRoute.map((r) => ({
              route_id: r.routeId, route_name: r.routeName, median_ft: Math.round(r.medianFt), segments: r.pairCount,
            })))} />
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {spacing.perRoute.slice(0, 12).map((r) => (
              <button
                key={r.routeId}
                onClick={() => selectRoute(r.routeId)}
                className="w-full flex items-center gap-2 text-xs px-1.5 py-1 rounded hover:bg-cream transition-colors"
                title="Highlight this route's stops on the map"
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${r.routeColor}` }} />
                <span className="flex-1 text-left truncate text-dark-brown">{r.routeName}</span>
                <span className="tabular-nums text-warm-gray">{fmtFt(r.medianFt)}</span>
              </button>
            ))}
            {spacing.perRoute.length > 12 && (
              <p className="text-[10px] text-warm-gray px-1.5">+{spacing.perRoute.length - 12} more in the CSV</p>
            )}
          </div>
        </div>
      </Section>

      {/* ── Feature 2: Stop balancing ── */}
      <Section
        title="Stop balancing candidates"
        subtitle={`${balancing.candidates.length} pairs · ~${vehHoursSaved.toFixed(1)} veh-hr/day`}
        open={!!open.balancing}
        onToggle={() => toggle('balancing')}
      >
        <div className="bg-teal-light rounded-lg p-2.5 text-xs text-dark-brown">
          <span className="font-heading font-bold">{balancing.candidates.length}</span> too-close pairs flagged
          {balancing.candidates.length > 0 && (
            <> · est. <span className="font-heading font-bold">{vehHoursSaved.toFixed(1)}</span> vehicle-hours/day saved if the tighter stop is removed</>
          )}
        </div>
        <div className="flex gap-2">
          <NumField label="Threshold (ft)" value={balanceThresholdFt} onChange={setBalanceThresholdFt} step={50} />
          <NumField label="Sec / stop" value={dwellSeconds} onChange={setDwellSeconds} step={1} />
        </div>
        <p className="text-[10px] text-warm-gray">
          Savings = {dwellSeconds}s × trips/day per candidate. Order-of-magnitude only. Terminals and stations are excluded.
        </p>
        {balancing.candidates.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <MapToggle on={mapOverlay === 'balancing'} onChange={(v) => setOverlay('balancing', v)} label="Show removal candidates on map" />
              <CsvButton onClick={() => exportCsv('stop-balancing-candidates.csv', balancing.candidates.map((c) => ({
                route_id: c.routeId, route_name: c.routeName, direction: c.directionLabel,
                stop_a_id: c.stopAId, stop_a_name: c.stopAName, stop_b_id: c.stopBId, stop_b_name: c.stopBName,
                spacing_ft: Math.round(c.spacingFt), trips_per_day: c.tripsPerDay,
                savings_sec_per_day: c.savingsSecPerDay, removal_stop_id: c.removalStopId, note: c.note ?? '',
              })))} />
            </div>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {balancing.candidates.slice(0, 10).map((c, i) => (
                <div key={`${c.routeId}-${c.stopAId}-${c.stopBId}-${i}`} className="bg-cream rounded-lg p-2 text-xs">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `#${c.routeColor}` }} />
                    <span className="font-semibold text-dark-brown truncate">{c.routeName}</span>
                    <span className="ml-auto tabular-nums text-warm-gray">{fmtFt(c.spacingFt)}</span>
                  </div>
                  <div className="text-warm-gray truncate">{c.stopAName} → {c.stopBName}</div>
                  <div className="text-[10px] text-warm-gray mt-0.5">
                    {c.tripsPerDay} trips/day · ~{(c.savingsSecPerDay / 60).toFixed(0)} min/day · remove <span className="text-coral font-medium">{c.removalStopName}</span>
                  </div>
                </div>
              ))}
              {balancing.candidates.length > 10 && (
                <p className="text-[10px] text-warm-gray px-1">+{balancing.candidates.length - 10} more in the CSV</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-warm-gray italic">No consecutive stops closer than {balanceThresholdFt} ft.</p>
        )}
      </Section>

      {/* ── Feature 3: Service intensity ── */}
      <Section
        title="Service intensity per stop"
        subtitle={`${intensity.length.toLocaleString()} served stops · ${repDay.label}`}
        open={!!open.intensity}
        onToggle={() => toggle('intensity')}
      >
        {calendars.length > 0 && (
          <label className="block">
            <span className="block text-[10px] text-warm-gray mb-0.5">Service day</span>
            <select
              value={serviceOverride}
              onChange={(e) => setServiceOverride(e.target.value)}
              className="w-full px-2 py-1 border border-sand rounded-md text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">Auto — busiest weekday ({repDay.label})</option>
              {calendars.map((c) => (
                <option key={c.service_id} value={c.service_id}>{c._description || c.service_id}</option>
              ))}
            </select>
          </label>
        )}
        {intensity.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <MapToggle on={mapOverlay === 'intensity'} onChange={(v) => setOverlay('intensity', v)} label="Colour stops by trips/day" />
              <CsvButton onClick={() => exportCsv('service-intensity.csv', intensity.map((s) => ({
                stop_id: s.stopId, stop_name: s.stopName, route_count: s.routeCount, trips_per_day: s.tripsPerDay,
                first_departure: depLabel(s.firstDepartureSec), last_departure: depLabel(s.lastDepartureSec),
                span_hours: s.spanHours == null ? '' : s.spanHours.toFixed(2),
                headway_peak_min: s.headwayPeakMin == null ? '' : Math.round(s.headwayPeakMin),
                headway_offpeak_min: s.headwayOffpeakMin == null ? '' : Math.round(s.headwayOffpeakMin),
              })))} />
            </div>
            <div className="border border-sand rounded-lg overflow-hidden">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="bg-cream text-warm-gray uppercase tracking-wide">
                    <th className="px-2 py-1.5 text-left font-semibold">Stop</th>
                    <th className="px-1.5 py-1.5 text-right font-semibold">Trips</th>
                    <th className="px-1.5 py-1.5 text-right font-semibold">Span</th>
                    <th className="px-1.5 py-1.5 text-right font-semibold" title="Peak headway">Pk</th>
                    <th className="px-1.5 py-1.5 text-right font-semibold" title="Off-peak headway">Off</th>
                  </tr>
                </thead>
                <tbody>
                  {intensity.slice(0, 12).map((s, i) => (
                    <tr key={s.stopId} className={i % 2 ? 'bg-cream/50' : ''}>
                      <td className="px-2 py-1 text-dark-brown truncate max-w-[120px]" title={s.stopName}>{s.stopName}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-dark-brown">{s.tripsPerDay}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-warm-gray">{fmtHours(s.spanHours)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-warm-gray">{fmtMin(s.headwayPeakMin)}</td>
                      <td className="px-1.5 py-1 text-right tabular-nums text-warm-gray">{fmtMin(s.headwayOffpeakMin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {intensity.length > 12 && (
              <p className="text-[10px] text-warm-gray">Top 12 by trips/day shown · full table in the CSV</p>
            )}
          </>
        ) : (
          <p className="text-xs text-warm-gray italic">No trips on the selected service day.</p>
        )}
      </Section>

      {/* ── Feature 4: Accessibility completeness ── */}
      <Section
        title="Accessibility completeness"
        subtitle={`${accessibility.pctPopulated.toFixed(0)}% of stops have wheelchair info`}
        open={!!open.accessibility}
        onToggle={() => toggle('accessibility')}
      >
        <div className="bg-cream rounded-lg p-3 flex items-center gap-3">
          <div className="font-heading font-extrabold text-2xl text-dark-brown tabular-nums">
            {accessibility.pctPopulated.toFixed(0)}%
          </div>
          <div className="text-[11px] text-warm-gray">
            of {accessibility.totalStops.toLocaleString()} board points have <code>wheelchair_boarding</code> set.
            <span className="block text-coral font-medium">{accessibility.gapCount.toLocaleString()} missing</span>
          </div>
        </div>
        <p className="text-[10px] text-warm-gray">
          Missing values also surface in the{' '}
          <button
            onClick={() => { setBottomPanelTab('validation'); setBottomPanelOpen(true); }}
            className="text-teal font-semibold hover:underline"
          >Validation</button>{' '}panel.
        </p>
        {accessibility.gapCount > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <MapToggle on={mapOverlay === 'accessibility'} onChange={(v) => setOverlay('accessibility', v)} label="Pin stops missing info" />
              <CsvButton label="Gaps CSV" onClick={() => exportCsv('accessibility-gaps.csv', accessibility.perRoute.map((r) => ({
                route_id: r.routeId, route_name: r.routeName, stops: r.total, populated: r.populated,
                gaps: r.gapCount, pct_populated: r.pctPopulated.toFixed(1),
              })))} />
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {accessibility.perRoute.filter((r) => r.gapCount > 0).slice(0, 12).map((r) => (
                <div key={r.routeId} className="flex items-center gap-2 text-xs px-1.5 py-1">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${r.routeColor}` }} />
                  <span className="flex-1 truncate text-dark-brown">{r.routeName}</span>
                  <span className="tabular-nums text-warm-gray">{r.pctPopulated.toFixed(0)}%</span>
                  <span className="tabular-nums text-coral w-10 text-right">{r.gapCount} gap</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-teal font-medium">✓ Every board point has wheelchair info.</p>
        )}
      </Section>
    </div>
  );
}
