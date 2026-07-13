import {
  PROFILE_CATEGORIES,
  categoryShare,
  type WalkshedProfile,
} from '../../services/walkshedProfile';

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

function pctOrDash(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

/**
 * The demographic profile of a walkshed: WHO is inside it, by category.
 *
 * This is a count, not a forecast. It says nothing about how many of these
 * people will ride — GTFS·X does not model ridership, and this table must never
 * grow a "predicted boardings" column.
 *
 * Two things the table is careful about, because getting them wrong would be
 * dishonest rather than merely imprecise:
 *
 *  1. The categories OVERLAP and DO NOT SUM. One person is counted in
 *     "Low-income", "Carless", "65+", "Ridership propensity" and "Transit need"
 *     at once. There is therefore NO total row, and there never should be.
 *  2. Rows are labelled `count` (an exact census-block ACS tabulation) or `est.`
 *     (the two PUMS-derived de-duplicated unions). They are not the same kind of
 *     number and are not blurred together. `Jobs` is workplace-based; every other
 *     row is residence-based.
 *
 * The badge vocabulary is deliberately the SAME as the demand-dot map's layer
 * control ("estimate" on the composite, "ACS count" on each segment). The two
 * features now report the same numbers from the same pipeline, and they must not
 * describe them with different words.
 */
export function WalkshedProfileTable({
  profile,
  compact = false,
}: {
  profile: WalkshedProfile;
  /** Drop the share column (narrow contexts, e.g. the stop sub-panel). */
  compact?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="border border-sand rounded-lg overflow-hidden min-w-[260px]">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-cream text-warm-gray uppercase tracking-wide">
              <th className="px-2 py-1.5 text-left font-semibold">Category</th>
              <th className="px-2 py-1.5 text-right font-semibold">In walkshed</th>
              {!compact && (
                <th className="px-2 py-1.5 text-right font-semibold" title="Share of this category's own universe inside the same walkshed">
                  Share
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {PROFILE_CATEGORIES.map((cat, i) => {
              const isEstimate = cat.kind === 'estimate';
              return (
                <tr key={cat.key} className={i % 2 ? 'bg-cream/50' : ''}>
                  <td className="px-2 py-1 text-dark-brown">
                    <span className="inline-flex items-center gap-1">
                      {cat.label}
                      <span
                        title={cat.note}
                        aria-label={cat.note}
                        role="img"
                        className="cursor-help leading-none text-warm-gray/80 hover:text-teal"
                      >
                        ⓘ
                      </span>
                      {isEstimate && (
                        <span className="rounded border border-amber-300 bg-amber-50 px-1 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                          est.
                        </span>
                      )}
                      {cat.basis === 'workplace' && (
                        <span className="rounded border border-sand bg-white px-1 text-[9px] font-bold uppercase tracking-wide text-warm-gray">
                          workplace
                        </span>
                      )}
                    </span>
                  </td>
                  <td
                    className={`px-2 py-1 text-right tabular-nums font-semibold ${
                      isEstimate ? 'text-amber-700' : 'text-dark-brown'
                    }`}
                  >
                    {fmt(profile.counts[cat.key])}
                  </td>
                  {!compact && (
                    <td className="px-2 py-1 text-right tabular-nums text-warm-gray">
                      {pctOrDash(categoryShare(profile, cat))}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The caveats that make the table above honest. Rendered under every profile —
 * both the stop sub-panel and the route sub-panel — so the "do not sum these"
 * warning is never separated from the numbers it applies to.
 */
export function WalkshedProfileNotes({ profile }: { profile: WalkshedProfile }) {
  return (
    <div className="space-y-1.5">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-2">
        <p className="text-[10px] leading-relaxed text-amber-900">
          <span className="font-semibold">These categories overlap — do not add them up.</span>{' '}
          The same person can be counted as low-income, carless, 65+, and in both composites at
          once. There is no "total people served" number here, and adding the rows together would
          invent one.
        </p>
      </div>
      <p className="text-[10px] leading-relaxed text-warm-gray">
        <span className="font-semibold text-dark-brown">Counts</span> are exact ACS tabulations of
        the {fmt(profile.blocksCounted)} census{' '}
        {profile.blocksCounted === 1 ? 'block' : 'blocks'} whose center falls inside the walkshed.{' '}
        <span className="font-semibold text-dark-brown">Ridership propensity</span> and{' '}
        <span className="font-semibold text-dark-brown">Transit need</span> are the two rows that
        are <span className="font-semibold">not</span> counts. They are de-duplicated{' '}
        <span className="font-semibold">unions</span>: someone who is both carless and low-income is
        counted once, not twice. The ACS publishes no joint distribution below the PUMA level, so
        that overlap is estimated from Census PUMS person records rather than assumed — the same
        model, from the same pipeline, as the demand-dot map. Neither is a{' '}
        <span className="font-semibold">ridership forecast</span>: they do not predict boardings.{' '}
        <span className="font-semibold text-dark-brown">Jobs</span> are counted at the workplace
        (LODES); every other row counts people where they live, so the two never add together.
      </p>
    </div>
  );
}
