import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import {
  computeStopPatterns,
  generateShapesFromStops,
  type ShapeGenMode,
  type ShapesFromStopsSummary,
} from '../../services/shapesFromStops';

export interface ShapesFromStopsDialogProps {
  onClose: () => void;
  /**
   * RTAP-flavoured intro banner (import-time wizard entry only). Mirrors the
   * confidence split in services/rtapDetect.ts's RtapSignals: 'high' (an
   * explicit "National RTAP" self-mention) names the tool outright; 'low'
   * (structural resemblance only) hedges to "has some of the hallmarks of".
   * Omit entirely when the feed wasn't flagged as RTAP-like at all.
   */
  rtapConfidence?: 'high' | 'low';
}

const TITLE_ID = 'shapes-from-stops-title';

// "Generate shapes from stops" — the interactive repair recipe for a feed
// with no route geometry. Two entry points render this: the Validation panel
// (no_shape_geometry warning, an interactive fix — see services/
// validationFixes.ts) and the import wizard when it detects an RTAP-built
// feed (rtapConfidence). Both just render <ShapesFromStopsDialog onClose={...}
// /> conditionally; all the logic lives here.
//
// Structure mirrors ExportDialog (fixed-inset overlay, rounded-2xl card,
// scrollable body between a fixed header/footer) with the a11y additions from
// TalkToSalesModal (role="dialog", focus trap, Escape, return focus on close).
// One deliberate departure: while a generation is running, Escape/backdrop/×
// ABORT rather than silently close — the run is mutating the store in the
// background, and closing without a way back to summary.undo() would strand
// whatever it had already written.
export function ShapesFromStopsDialog({ onClose, rtapConfidence }: ShapesFromStopsDialogProps) {
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const stops = useStore((s) => s.stops);
  const shapes = useStore((s) => s.shapes);
  const routes = useStore((s) => s.routes);

  // Preview: computeStopPatterns is pure, so this is safe to run on every
  // render of the open dialog (and recomputes automatically if the user
  // edits the feed in another tab while this one is open).
  const patterns = useMemo(
    () => computeStopPatterns(trips, stopTimes, stops, shapes),
    [trips, stopTimes, stops, shapes],
  );
  const routeIds = useMemo(() => [...new Set(patterns.map((p) => p.routeId))], [patterns]);
  const tripsAffected = useMemo(
    () => patterns.reduce((n, p) => n + p.tripIds.length, 0),
    [patterns],
  );
  const routeName = (routeId: string) => {
    const r = routes.find((rt) => rt.route_id === routeId);
    return r?.route_short_name || r?.route_long_name || routeId;
  };
  const hasWork = patterns.length > 0;

  const [mode, setMode] = useState<ShapeGenMode>('snap');
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<ShapesFromStopsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const dismiss = () => {
    if (running) { abortRef.current?.abort(); setCancelling(true); return; }
    onClose();
  };

  const handleGenerate = async () => {
    setError(null);
    setSummary(null);
    setCancelling(false);
    setRunning(true);
    setProgress({ done: 0, total: patterns.length });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await generateShapesFromStops({
        mode,
        onProgress: (done, total) => setProgress({ done, total }),
        signal: controller.signal,
      });
      setSummary(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong generating shapes.');
    } finally {
      setRunning(false);
      setCancelling(false);
      abortRef.current = null;
    }
  };

  // Focus management: capture whatever had focus before the dialog opened,
  // move focus into the dialog, and restore it on unmount — so keyboard users
  // land back on the trigger (the Fix button / import-wizard CTA) rather than
  // the document body.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
    const raf = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocused.current?.focus?.();
    };
  }, []);

  // Escape + Tab-trap. Kept as its own effect (re-armed when `running`
  // changes) so Escape always sees the current abort-vs-close decision
  // without pulling `dismiss` — a new function every render — into the deps.
  useEffect(() => {
    function focusables(): HTMLElement[] {
      if (!cardRef.current) return [];
      return Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('inert') && el.offsetParent !== null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (running) { abortRef.current?.abort(); setCancelling(true); } else onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-3 shrink-0 flex items-start justify-between gap-3">
          <div>
            <h3 id={TITLE_ID} className="font-heading font-bold text-lg text-dark-brown mb-1">
              Generate shapes from stops
            </h3>
            <p className="text-xs text-warm-gray">
              Build route geometry (shapes.txt) from your stop sequences.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close"
            onClick={dismiss}
            className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-md text-warm-gray hover:bg-cream hover:text-brown"
          >
            <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>

        {/* Scrollable body — header and footer stay put when the route/mode
            list or result callouts run long. */}
        <div className="flex-1 overflow-y-auto px-6 pt-1 pb-1">
          {rtapConfidence && !summary && (
            <div className="mb-4 rounded-lg bg-teal-light border border-teal/30 px-3 py-2 text-xs text-dark-brown">
              {rtapConfidence === 'high' ? (
                <>This looks like a National RTAP GTFS Builder feed. That tool ships shapes.txt
                empty by default, so generating geometry here is the recommended fix.</>
              ) : (
                <>This has some of the hallmarks of a spreadsheet-based GTFS Builder export (the
                kind National RTAP provides), which often ships without usable geometry.
                Generating shapes here is worth a look.</>
              )}
            </div>
          )}

          {!hasWork && !summary ? (
            <p className="text-sm text-warm-gray py-4">
              Your feed already has route geometry for every trip. There's nothing to generate here.
            </p>
          ) : summary ? (
            <ResultSummary summary={summary} />
          ) : (
            <>
              <div className="mb-4 rounded-lg bg-cream px-3 py-2 text-sm text-dark-brown">
                <p>
                  <span className="font-semibold">{patterns.length}</span>{' '}
                  stop pattern{patterns.length === 1 ? '' : 's'} across{' '}
                  <span className="font-semibold">{routeIds.length}</span>{' '}
                  route{routeIds.length === 1 ? '' : 's'} need{patterns.length === 1 ? 's' : ''} geometry
                  {' '}({tripsAffected} trip{tripsAffected === 1 ? '' : 's'} will be linked to a new shape).
                </p>
                {routeIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {routeIds.slice(0, 8).map((rid) => (
                      <code
                        key={rid}
                        className="px-2 py-0.5 rounded bg-white border border-sand text-dark-brown text-xs font-mono"
                      >
                        {routeName(rid)}
                      </code>
                    ))}
                    {routeIds.length > 8 && (
                      <span className="px-2 py-0.5 text-xs text-warm-gray italic">
                        +{routeIds.length - 8} more
                      </span>
                    )}
                  </div>
                )}
              </div>

              <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1.5">
                How should the geometry be built?
              </p>
              <div role="radiogroup" aria-label="Shape generation mode" className="flex flex-col gap-2 mb-4">
                <ModeOption
                  selected={mode === 'snap'}
                  onSelect={() => setMode('snap')}
                  disabled={running}
                  title="Snap to roads (recommended)"
                  description="Follows the street network by routing between your stops (the same road routing the timetable's Estimate times uses)."
                />
                <ModeOption
                  selected={mode === 'straight'}
                  onSelect={() => setMode('straight')}
                  disabled={running}
                  title="Straight lines between stops"
                  description="Instant, no network calls. Use this when a route runs off the road network (rural/unmapped stops, a ferry, or a rail alignment)."
                />
              </div>

              {running && progress && (
                <div className="mb-2">
                  <div className="flex items-center justify-between text-xs text-warm-gray mb-1">
                    <span>
                      {cancelling
                        ? 'Cancelling…'
                        : `Generating… ${progress.done} of ${progress.total} pattern${progress.total === 1 ? '' : 's'}`}
                    </span>
                    <span className="tabular-nums">
                      {progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%
                    </span>
                  </div>
                  <div
                    className="h-2 rounded-full bg-sand overflow-hidden"
                    role="progressbar"
                    aria-valuenow={progress.done}
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                  >
                    <div
                      className="h-full bg-teal transition-[width] duration-200"
                      style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}

              {error && (
                <div className="mb-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-sand shrink-0 flex gap-2">
          {summary ? (
            <>
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light transition-colors"
              >
                Done
              </button>
              {summary.shapesCreated > 0 && (
                <button
                  onClick={() => { summary.undo(); onClose(); }}
                  className="flex-1 px-4 py-2.5 bg-white border border-coral text-coral rounded-lg font-heading font-bold text-sm hover:bg-coral-light transition-colors"
                >
                  Undo
                </button>
              )}
            </>
          ) : !hasWork ? (
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
            >
              Close
            </button>
          ) : (
            <>
              <button
                onClick={dismiss}
                disabled={cancelling}
                className="flex-1 px-4 py-2.5 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
              <button
                onClick={handleGenerate}
                disabled={running}
                className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {running ? 'Generating…' : 'Generate shapes'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Radio-card for the snap/straight mode choice — same selected-state colours
// (teal border + teal-light fill) as the validation panel's wheelchair-value
// picker, but two lines (title + description) since each mode needs a reason.
function ModeOption({
  selected, onSelect, disabled, title, description,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className={`text-left px-3 py-2.5 rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        selected ? 'border-teal bg-teal-light' : 'border-sand hover:border-teal/50'
      }`}
    >
      <p className={`text-sm font-semibold ${selected ? 'text-teal' : 'text-dark-brown'}`}>{title}</p>
      <p className="text-xs text-warm-gray mt-0.5">{description}</p>
    </button>
  );
}

// Post-run summary — one calm "done" line plus a callout per outcome bucket
// that needs a human look (partial matches, straight-line fallbacks, and the
// rare unexpected failure). Skipped patterns (too few located stops) get a
// quiet note since there's nothing actionable there.
function ResultSummary({ summary }: { summary: ShapesFromStopsSummary }) {
  const failedCount = summary.results.filter((r) => r.outcome === 'failed').length;
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="rounded-lg bg-teal-light px-3 py-2 text-sm text-dark-brown">
        Created <span className="font-semibold">{summary.shapesCreated}</span>{' '}
        shape{summary.shapesCreated === 1 ? '' : 's'} and linked{' '}
        <span className="font-semibold">{summary.tripsUpdated}</span>{' '}
        trip{summary.tripsUpdated === 1 ? '' : 's'}.
      </div>
      {summary.partialCount > 0 && (
        <div className="rounded-lg bg-gold-light border border-gold px-3 py-2 text-xs text-amber-800">
          <span className="font-semibold">{summary.partialCount}</span>{' '}
          pattern{summary.partialCount === 1 ? '' : 's'} matched only partially (the road network
          had a gap). Review {summary.partialCount === 1 ? 'this one' : 'these'} before publishing.
        </div>
      )}
      {summary.straightCount > 0 && (
        <div className="rounded-lg bg-cream border border-sand px-3 py-2 text-xs text-dark-brown">
          <span className="font-semibold">{summary.straightCount}</span>{' '}
          pattern{summary.straightCount === 1 ? '' : 's'} fell back to a straight line between stops.
        </div>
      )}
      {summary.skippedCount > 0 && (
        <p className="text-xs text-warm-gray px-1">
          {summary.skippedCount} pattern{summary.skippedCount === 1 ? '' : 's'} skipped (fewer than
          2 located stops).
        </p>
      )}
      {failedCount > 0 && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {failedCount} pattern{failedCount === 1 ? '' : 's'} failed unexpectedly and were left
          without geometry.
        </div>
      )}
    </div>
  );
}
