import { useState, useCallback } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { fetchCensusData, lookupFips } from '../../services/demographics';
import { calculateTitleVI, type TitleVIResult, type TitleVIGroup } from '../../services/titleVI';

function fmt(n: number, decimals = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function pct(share: number): string {
  return (share * 100).toFixed(1) + '%';
}

function RatioIndicator({ ratio }: { ratio: number }) {
  const color =
    ratio >= 1.0 ? 'text-emerald-600 bg-emerald-50 border-emerald-200' :
    ratio >= 0.8 ? 'text-amber-600 bg-amber-50 border-amber-200' :
                   'text-red-600 bg-red-50 border-red-200';
  const label =
    ratio >= 1.0 ? 'Equitable' :
    ratio >= 0.8 ? 'Moderate disparity' :
                   'Potential disparity';
  return (
    <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${color}`}>
      <span className="text-sm font-bold">{fmt(ratio, 2)}</span>
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

function GroupColumn({ label, group, isMinority }: { label: string; group: TitleVIGroup; isMinority: boolean }) {
  return (
    <div className={`flex-1 rounded-lg p-3 space-y-2 ${isMinority ? 'bg-purple-50' : 'bg-teal-light'}`}>
      <p className={`text-xs font-bold uppercase tracking-wide ${isMinority ? 'text-purple' : 'text-teal'}`}>
        {label}
      </p>
      <div>
        <p className="font-heading font-bold text-lg text-dark-brown">{fmt(group.avgDailyTrips)}</p>
        <p className="text-[11px] text-warm-gray">avg. daily trips</p>
      </div>
      <div>
        <p className="font-heading font-bold text-sm text-dark-brown">{group.count}</p>
        <p className="text-[11px] text-warm-gray">block groups</p>
      </div>
      <div>
        <p className="font-heading font-bold text-sm text-dark-brown">{group.totalPop.toLocaleString()}</p>
        <p className="text-[11px] text-warm-gray">population</p>
      </div>
    </div>
  );
}

export function TitleVIPanel() {
  const stops = useStore((s) => s.stops);
  const [result, setResult] = useState<TitleVIResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = useCallback(async () => {
    if (stops.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      const avgLat = stops.reduce((sum, s) => sum + s.stop_lat, 0) / stops.length;
      const avgLon = stops.reduce((sum, s) => sum + s.stop_lon, 0) / stops.length;
      const { stateFips, countyFips } = await lookupFips(avgLat, avgLon);
      const blockGroups = await fetchCensusData(stateFips, countyFips);
      const state = useStore.getState();
      setResult(calculateTitleVI(stops, blockGroups, state));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [stops]);

  if (stops.length === 0) {
    return (
      <EmptyState
        icon="⚖"
        title="No Stops Yet"
        description="Add stops to your routes before running a Title VI analysis."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-warm-gray">
        Compares transit service levels between minority and non-minority block groups per
        FTA Circular 4702.1B. Threshold is the regional average minority share.
      </p>

      <button
        onClick={handleAnalyze}
        disabled={loading}
        className="w-full px-4 py-2.5 bg-teal text-white rounded-lg font-heading font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Analyzing…' : result ? 'Re-run Analysis' : 'Run Title VI Analysis'}
      </button>

      {loading && (
        <div className="text-center py-6">
          <div className="inline-block w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin mb-2" />
          <p className="text-sm text-warm-gray">Fetching Census race/ethnicity data…</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700 font-medium">Error</p>
          <p className="text-xs text-red-600 mt-1">{error}</p>
        </div>
      )}

      {result && !loading && (
        <div className="space-y-3">
          {/* ── Race / ethnicity ── */}
          <h3 className="font-heading font-bold text-sm text-dark-brown">Race / ethnicity</h3>
          <div className="bg-cream rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-warm-gray">Regional minority share (threshold)</span>
            <span className="text-sm font-bold text-dark-brown">{pct(result.regionalMinorityShare)}</span>
          </div>
          <div className="flex gap-2">
            <GroupColumn label="Minority" group={result.minority} isMinority={true} />
            <GroupColumn label="Non-Minority" group={result.nonMinority} isMinority={false} />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Minority / Non-Minority Ratio
            </p>
            <RatioIndicator ratio={result.ratio} />
            <p className="text-[10px] text-warm-gray mt-1">
              Ratio &lt; 1.0 indicates minority block groups receive fewer average daily
              trips. Ratios below 0.80 may warrant further review under FTA Circular 4702.1B.
            </p>
          </div>

          {/* ── Income (Environmental Justice) ── */}
          <h3 className="font-heading font-bold text-sm text-dark-brown pt-1">Income (Environmental Justice)</h3>
          <div className="bg-cream rounded-lg px-3 py-2 flex items-center justify-between">
            <span className="text-xs text-warm-gray">Regional low-income share (threshold)</span>
            <span className="text-sm font-bold text-dark-brown">{pct(result.regionalLowIncomeShare)}</span>
          </div>
          <div className="flex gap-2">
            <GroupColumn label="Low-Income" group={result.lowIncome} isMinority={true} />
            <GroupColumn label="Higher-Income" group={result.nonLowIncome} isMinority={false} />
          </div>
          <div>
            <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Low-Income / Higher-Income Ratio
            </p>
            <RatioIndicator ratio={result.lowIncomeRatio} />
            <p className="text-[10px] text-warm-gray mt-1">
              Low-income = block groups above the regional share of population under 200% of the
              federal poverty line. Ratio &lt; 1.0 indicates these areas receive fewer average daily trips.
            </p>
          </div>

          {/* Methodology note */}
          <p className="text-[10px] text-warm-gray border-t border-sand pt-2">
            Service metric: apportioned daily trips per block group (unique trip visits, weighted
            by circle-overlap fraction with a 0.5 mi stop buffer). Source: ACS 5-Year B03002 (race)
            and C17002 (income-to-poverty).
          </p>
        </div>
      )}
    </div>
  );
}
