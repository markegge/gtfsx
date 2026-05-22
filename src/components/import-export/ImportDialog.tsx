import React, { useState, useCallback } from 'react';
import { parseGtfsInWorker, inspectGtfsZip, loadImportIntoStore, mergeImportIntoStore, type ImportData } from '../../services/gtfsImport';
import { useStore } from '../../store';
import type { Route } from '../../types/gtfs';
import { CatalogSearch, type CatalogFeed } from './CatalogSearch';

type ImportSource = 'upload' | 'url' | 'catalog';

type ImportMode = 'replace' | 'merge';

/** Compute a [[west, south], [east, north]] bounding box covering all stops
 * and shape points in the imported feed. Returns null if no coordinates. */
function computeImportBounds(data: ImportData): [[number, number], [number, number]] | null {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let any = false;
  for (const s of data.stops) {
    if (Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon)) {
      minLat = Math.min(minLat, s.stop_lat);
      maxLat = Math.max(maxLat, s.stop_lat);
      minLon = Math.min(minLon, s.stop_lon);
      maxLon = Math.max(maxLon, s.stop_lon);
      any = true;
    }
  }
  for (const sh of data.shapes) {
    for (const p of sh.points) {
      if (Number.isFinite(p.shape_pt_lat) && Number.isFinite(p.shape_pt_lon)) {
        minLat = Math.min(minLat, p.shape_pt_lat);
        maxLat = Math.max(maxLat, p.shape_pt_lat);
        minLon = Math.min(minLon, p.shape_pt_lon);
        maxLon = Math.max(maxLon, p.shape_pt_lon);
        any = true;
      }
    }
  }
  return any ? [[minLon, minLat], [maxLon, maxLat]] : null;
}

function fitMapToImport(data: ImportData) {
  const bounds = computeImportBounds(data);
  if (!bounds) return;
  // Defer so the map has at least one tick to ingest the new route/stop
  // layers before animating — otherwise fitBounds can race against the
  // initial mount and appear to do nothing.
  setTimeout(() => window.__mapFitBounds?.(bounds), 100);
}

interface ImportDialogProps {
  onClose: () => void;
  /** Overrides the success-screen primary button. When set, the button runs
   * this handler (with a "Saving…" busy state) instead of merely closing —
   * used by the org dashboard to persist the freshly imported feed as an
   * org-owned project. Defaults to the editor's "Open in Editor" → onClose. */
  onComplete?: () => void | Promise<void>;
  completeLabel?: string;
}

export function ImportDialog({ onClose, onComplete, completeLabel }: ImportDialogProps) {
  const [source, setSource] = useState<ImportSource>('upload');
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  // Live parse phase from the worker (e.g. "Parsing stop times…"), shown in
  // place of a static "Parsing…" so large feeds don't look frozen.
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');

  // After parsing
  const [parsedData, setParsedData] = useState<ImportData | null>(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<ImportMode>('replace');
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());

  // Warnings from parsing
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  // Large-feed confirmation gate. Set by the pre-flight size check before the
  // (expensive, main-thread-blocking) parse so the user can back out instead
  // of hanging/crashing the tab.
  const [pendingLarge, setPendingLarge] = useState<
    { file: File; info: Awaited<ReturnType<typeof inspectGtfsZip>> } | null
  >(null);

  // Success state
  const [importedCounts, setImportedCounts] = useState<{
    routes: number; stops: number; trips: number;
  } | null>(null);

  // Async completion state (only used when onComplete is provided).
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const handleComplete = useCallback(async () => {
    if (!onComplete) {
      onClose();
      return;
    }
    setCompleteError(null);
    setCompleting(true);
    try {
      await onComplete();
    } catch (e) {
      setCompleteError(e instanceof Error ? e.message : 'Could not save feed');
      setCompleting(false);
    }
  }, [onComplete, onClose]);

  /** Wholesale replace the current project with the imported feed. Matches
   * the first-time-import flow: clear all existing state, load the new feed,
   * rename the project, pan/zoom the map to the new routes, and surface the
   * success screen. */
  const doReplaceImport = useCallback((data: ImportData, name: string) => {
    loadImportIntoStore(data);
    useStore.getState().setProjectName(name);
    fitMapToImport(data);
    // Treat the import as a load, not an edit — clear dirty so the
    // beforeunload prompt only fires once the user actually modifies the
    // freshly imported feed.
    useStore.getState().markSaved();
    setImportedCounts({
      routes: data.routes.length,
      stops: data.stops.length,
      trips: data.trips.length,
    });
  }, []);

  // The actual (expensive) parse. Always reached via parseFile so every entry
  // point — upload, URL, catalog — goes through the size pre-flight first.
  const runParse = useCallback(async (file: File) => {
    setParsing(true);
    setProgress(null);
    setError(null);
    try {
      const data = await parseGtfsInWorker(file, ({ phase, rows }) =>
        setProgress(rows ? `${phase} ${rows.toLocaleString()} rows` : phase),
      );
      const name = file.name.replace(/\.zip$/i, '');
      setImportWarnings(data.warnings);
      // If the project is empty, skip the options screen and import immediately
      if (useStore.getState().routes.length === 0) {
        doReplaceImport(data, name);
        return;
      }
      setParsedData(data);
      setFileName(name);
      // Select all routes by default
      setSelectedRouteIds(new Set(data.routes.map((r) => r.route_id)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to parse GTFS feed');
    } finally {
      setParsing(false);
      setProgress(null);
    }
  }, [doReplaceImport]);

  const parseFile = useCallback(async (file: File) => {
    setError(null);
    // Cheap pre-flight: if stop_times is large, gate behind a confirmation
    // instead of charging into a parse that can hang or crash the tab. If the
    // inspection itself fails, fall through and let the real parse surface it.
    try {
      const info = await inspectGtfsZip(file);
      if (info.isLarge) {
        setPendingLarge({ file, info });
        return;
      }
    } catch {
      /* ignore — proceed to the normal parse path */
    }
    await runParse(file);
  }, [runParse]);

  const proceedWithLarge = useCallback(() => {
    if (!pendingLarge) return;
    const { file } = pendingLarge;
    setPendingLarge(null);
    runParse(file);
  }, [pendingLarge, runParse]);

  const cancelLarge = useCallback(() => {
    setPendingLarge(null);
    setError(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
  }, [parseFile]);

  const handleCatalogSelect = useCallback(async (feed: CatalogFeed, fileNameStem: string) => {
    const url = feed.latest_dataset?.hosted_url;
    if (!url) throw new Error('Feed has no dataset URL.');
    const proxied = `${window.location.origin}/_import/proxy?url=${encodeURIComponent(url)}`;
    setError(null);
    const r = await fetch(proxied);
    if (!r.ok) throw new Error(`Download failed: ${r.status} ${await r.text()}`);
    const blob = await r.blob();
    const file = new File([blob], `${fileNameStem}.zip`, { type: 'application/zip' });
    await parseFile(file);
  }, [parseFile]);

  const handleUrlFetch = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setError('Paste a GTFS feed URL first.');
      return;
    }
    setError(null);
    setParsing(true);
    try {
      const res = await fetch(
        `/api/import/fetch?url=${encodeURIComponent(trimmed)}`,
        { method: 'GET', headers: { 'X-GB-Client': 'web' }, credentials: 'omit' },
      );
      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        let message = `Import failed (${res.status}).`;
        if (ct.includes('application/json')) {
          try {
            const payload = (await res.json()) as { message?: string };
            if (payload?.message) message = payload.message;
          } catch {
            // fall through with default message
          }
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const stem =
        trimmed.split('/').pop()?.replace(/\.zip$/i, '') || 'imported-feed';
      const file = new File([blob], `${stem}.zip`, { type: 'application/zip' });
      await parseFile(file);
    } catch (e) {
      setError((e as Error).message || 'Failed to fetch feed.');
    } finally {
      setParsing(false);
    }
  }, [urlInput, parseFile]);

  const toggleRoute = (routeId: string) => {
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  };

  const handleImport = () => {
    if (!parsedData) return;

    if (mode === 'replace') {
      doReplaceImport(parsedData, fileName);
    } else {
      if (selectedRouteIds.size === 0) return;
      mergeImportIntoStore(parsedData, selectedRouteIds);
      // Count stops/trips for selected routes
      const selTripIds = new Set(
        parsedData.trips
          .filter((t) => selectedRouteIds.has(t.route_id))
          .map((t) => t.trip_id),
      );
      const selStopIds = new Set(
        parsedData.stopTimes
          .filter((st) => selTripIds.has(st.trip_id))
          .map((st) => st.stop_id),
      );
      // Fit the map to the subset of stops + shapes for the merged routes
      // so the user isn't left looking at the wrong metro.
      const selShapeIds = new Set(
        parsedData.trips
          .filter((t) => selectedRouteIds.has(t.route_id) && t.shape_id)
          .map((t) => t.shape_id as string),
      );
      const subset: ImportData = {
        ...parsedData,
        stops: parsedData.stops.filter((s) => selStopIds.has(s.stop_id)),
        shapes: parsedData.shapes.filter((sh) => selShapeIds.has(sh.shape_id)),
      };
      fitMapToImport(subset);
      setImportedCounts({
        routes: selectedRouteIds.size,
        stops: selStopIds.size,
        trips: selTripIds.size,
      });
    }
  };

  const routeLabel = (r: Route) =>
    [r.route_short_name, r.route_long_name].filter(Boolean).join(' — ') || r.route_id;

  // ── Success screen ─────────────────────────────────────────────────────────
  if (importedCounts) {
    return (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={completing ? undefined : onClose}>
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-teal-light rounded-lg flex items-center justify-center text-xl">✓</div>
            <h3 className="font-heading font-bold text-lg text-dark-brown">
              {mode === 'merge' ? 'Routes Added' : 'Import Successful'}
            </h3>
          </div>
          {importWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-xs text-amber-700">
              {importWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          )}
          <div className="flex flex-col gap-2 mb-4">
            {([['Routes', importedCounts.routes], ['Stops', importedCounts.stops], ['Trips', importedCounts.trips]] as [string, number][]).map(
              ([label, count]) => (
                <div key={label} className="flex justify-between px-3 py-2 bg-cream rounded-lg text-sm">
                  <span>{label}</span>
                  <span className="font-semibold">{count}</span>
                </div>
              ),
            )}
          </div>
          {completeError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4 text-sm text-red-700">
              {completeError}
            </div>
          )}
          <button
            onClick={handleComplete}
            disabled={completing}
            className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {completing ? 'Saving…' : onComplete ? (completeLabel ?? 'Save feed') : 'Open in Editor'}
          </button>
        </div>
      </div>
    );
  }

  // ── Large-feed warning gate ────────────────────────────────────────────────
  if (pendingLarge) {
    // Combined heavy-table footprint (stop_times + shapes) — what actually
    // strains memory — rounded for display.
    const mb = Math.round(
      (pendingLarge.info.stopTimesBytes + pendingLarge.info.shapesBytes) / (1024 * 1024),
    );
    const rows = pendingLarge.info.estimatedRows;
    return (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={parsing ? undefined : onClose}>
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center text-xl">⚠️</div>
            <h3 className="font-heading font-bold text-lg text-dark-brown">This feed is very large</h3>
          </div>
          <p className="text-sm text-warm-gray leading-relaxed mb-2">
            Its schedule data is about{' '}
            <span className="font-semibold text-dark-brown">~{rows.toLocaleString()} stop-time rows</span>{' '}
            (≈{mb} MB uncompressed). The browser-based editor holds the entire feed
            in memory, so feeds this size may load slowly or crash the tab.
          </p>
          <p className="text-sm text-warm-gray leading-relaxed mb-5">
            Consider a smaller or single-agency feed. You can still try to load it.
          </p>
          <div className="flex gap-2">
            <button
              onClick={cancelLarge}
              className="flex-1 px-4 py-2.5 border border-sand text-warm-gray rounded-lg font-heading font-bold text-sm hover:text-dark-brown hover:border-coral transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={proceedWithLarge}
              className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
            >
              Try anyway
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 2: Mode + route selection ────────────────────────────────────────
  if (parsedData) {
    const hasExistingRoutes = useStore.getState().routes.length > 0;

    return (
      <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">Import Options</h3>
          <p className="text-xs text-warm-gray mb-4">{fileName}.zip — {parsedData.routes.length} route{parsedData.routes.length !== 1 ? 's' : ''}</p>

          {importWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-xs text-amber-700">
              {importWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          )}

          {/* Mode selection */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => {
                if (!parsedData) return;
                setMode('replace');
                doReplaceImport(parsedData, fileName);
              }}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors bg-white text-warm-gray border-sand hover:border-coral hover:text-dark-brown"
            >
              Replace project
            </button>
            <button
              onClick={() => setMode('merge')}
              disabled={!hasExistingRoutes}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors
                ${mode === 'merge'
                  ? 'bg-coral text-white border-coral'
                  : 'bg-white text-warm-gray border-sand hover:border-coral hover:text-dark-brown'
                }
                disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Add to current project
            </button>
          </div>

          {/* Route list (merge mode) */}
          {mode === 'merge' && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-dark-brown uppercase tracking-wide">Select routes to import</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedRouteIds(new Set(parsedData.routes.map((r) => r.route_id)))}
                    className="text-[11px] text-coral hover:underline"
                  >
                    All
                  </button>
                  <button
                    onClick={() => setSelectedRouteIds(new Set())}
                    className="text-[11px] text-warm-gray hover:underline"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto border border-sand rounded-lg p-2">
                {parsedData.routes.map((r) => (
                  <label
                    key={r.route_id}
                    className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-cream cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRouteIds.has(r.route_id)}
                      onChange={() => toggleRoute(r.route_id)}
                      className="accent-coral"
                    />
                    <span
                      className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ backgroundColor: `#${r.route_color || '888888'}` }}
                    />
                    <span className="text-sm text-dark-brown truncate">{routeLabel(r)}</span>
                  </label>
                ))}
              </div>
              {selectedRouteIds.size === 0 && (
                <p className="text-xs text-amber-600 mt-1">Select at least one route.</p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => { setParsedData(null); setError(null); }}
              className="px-4 py-2 text-sm text-warm-gray hover:text-dark-brown"
            >
              ← Back
            </button>
            {mode === 'merge' && (
              <button
                onClick={handleImport}
                disabled={selectedRouteIds.size === 0}
                className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {`Add ${selectedRouteIds.size} route${selectedRouteIds.size !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1: Drop zone OR catalog search ────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Import GTFS Feed</h3>

        {/* Source switcher */}
        <div className="flex gap-1 p-1 bg-cream rounded-lg mb-4">
          <button
            onClick={() => setSource('upload')}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${source === 'upload' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
          >
            Upload File
          </button>
          <button
            onClick={() => setSource('url')}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${source === 'url' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
          >
            From URL
          </button>
          <button
            onClick={() => setSource('catalog')}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors
              ${source === 'catalog' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'}`}
          >
            Search Catalog
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {source === 'upload' && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`border-3 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer
              ${dragging ? 'border-coral bg-coral-light' : 'border-sand bg-cream hover:border-coral hover:bg-coral-light'}`}
          >
            {parsing ? (
              <p className="text-warm-gray">{progress ?? 'Parsing…'}</p>
            ) : (
              <>
                <div className="text-5xl mb-4">🚌</div>
                <p className="font-heading font-bold text-dark-brown mb-2">Drop your GTFS feed here</p>
                <p className="text-warm-gray text-sm mb-4">Upload a .zip file to start editing</p>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm cursor-pointer hover:bg-[#d4603a] transition-colors">
                  Browse Files
                  <input type="file" accept=".zip" className="hidden" onChange={handleFileInput} />
                </label>
              </>
            )}
          </div>
        )}

        {source === 'url' && (
          <div className="border border-sand rounded-2xl p-6">
            <label className="block text-xs font-semibold text-warm-gray uppercase tracking-wide mb-2">
              Public GTFS feed URL
            </label>
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !parsing) {
                  e.preventDefault();
                  handleUrlFetch();
                }
              }}
              disabled={parsing}
              placeholder="https://example.org/gtfs.zip"
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral disabled:opacity-50"
            />
            <p className="mt-2 text-xs text-warm-gray leading-relaxed">
              Paste a direct link to a GTFS <code className="font-mono">.zip</code>. Up to 100 MB; HTTPS preferred.
              Don't have a URL? Try <button onClick={() => setSource('catalog')} className="text-coral hover:underline">Search Catalog</button> to browse Mobility Database.
            </p>
            <button
              onClick={handleUrlFetch}
              disabled={parsing || !urlInput.trim()}
              className="mt-4 w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {parsing ? (progress ?? 'Fetching…') : 'Fetch feed'}
            </button>
          </div>
        )}

        {source === 'catalog' && (
          parsing ? (
            <div className="border border-sand rounded-lg p-12 text-center text-warm-gray">{progress ?? 'Parsing feed…'}</div>
          ) : (
            <CatalogSearch onSelect={handleCatalogSelect} />
          )
        )}

        <div className="flex justify-between mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-warm-gray hover:text-dark-brown">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
