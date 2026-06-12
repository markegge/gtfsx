import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { importGtfsZip, loadImportIntoStore } from '../../services/gtfsImport';
import { useStore } from '../../store';
import { AppBrand } from '../layout/AppBrand';
import { resolvePartnerLabel } from './partnerAttribution';

interface ImportErrorPayload {
  code: string;
  message: string;
}

async function fetchImport(
  params: URLSearchParams,
): Promise<{ blob: Blob; filename: string }> {
  // Forward only the parameters the worker knows about — never leak the
  // browser's entire querystring back to a backend.
  const qs = new URLSearchParams();
  for (const k of ['url', 'source', 'feed_id', 'onestop_id'] as const) {
    const v = params.get(k);
    if (v) qs.set(k, v);
  }

  const res = await fetch(`/api/import/fetch?${qs.toString()}`, {
    method: 'GET',
    headers: { 'X-GB-Client': 'web' },
    credentials: 'omit',
  });

  if (!res.ok) {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const payload = (await res.json()) as ImportErrorPayload;
      const err = new Error(payload.message) as Error & ImportErrorPayload;
      err.code = payload.code;
      err.message = payload.message;
      throw err;
    }
    const err = new Error(`Import failed (${res.status})`) as Error & ImportErrorPayload;
    err.code = 'fetch_failed';
    err.message = `Import failed (${res.status}).`;
    throw err;
  }

  const blob = await res.blob();

  // Derive a friendly filename from either the source label or the URL.
  let stem = 'imported-feed';
  const url = params.get('url');
  const feedId = params.get('feed_id');
  if (feedId) stem = `mdb-${feedId}`;
  else if (url) {
    try {
      const last = new URL(url).pathname.split('/').pop() || '';
      stem = last.replace(/\.zip$/i, '') || stem;
    } catch {
      // ignore — keep the default stem
    }
  }
  return { blob, filename: `${stem}.zip` };
}

export function DeepLinkImportPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<ImportErrorPayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'parsing' | 'done' | 'error'>('loading');

  const url = searchParams.get('url');
  const source = searchParams.get('source');
  const feedId = searchParams.get('feed_id');
  const ref = searchParams.get('ref') || undefined;

  // Pretty source string for the loading UI. Order matches §2.1–§2.3 of the
  // spec — catalog variants name the catalog; the URL variant names the host.
  let sourceDescription = '';
  if (source === 'mobilitydb' && feedId) sourceDescription = `Mobility Database feed ${feedId}`;
  else if (source === 'transitland') sourceDescription = 'transit.land';
  else if (url) {
    try {
      sourceDescription = new URL(url).hostname;
    } catch {
      sourceDescription = url;
    }
  }

  useEffect(() => {
    if (!url && !(source && feedId)) {
      setStatus('error');
      setError({
        code: 'missing_url',
        message: 'We need a GTFS feed URL to import.',
      });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { blob, filename } = await fetchImport(searchParams);
        if (cancelled) return;

        setStatus('parsing');
        const file = new File([blob], filename, { type: 'application/zip' });
        const data = await importGtfsZip(file);
        if (cancelled) return;

        loadImportIntoStore(data);
        useStore.getState().setProjectName(filename.replace(/\.zip$/i, ''));
        useStore.getState().markSaved();

        // Stash attribution for the editor banner. Source wins over ref — a
        // mobilitydb catalog import always shows the Mobility Database badge
        // even when the caller omits ?ref.
        const partnerLabel = resolvePartnerLabel(source, ref);
        if (partnerLabel) {
          try {
            sessionStorage.setItem('gb_import_partner', partnerLabel);
          } catch {
            // sessionStorage blocked — proceed without the badge.
          }
        }

        setStatus('done');
        // Redirect to the editor. Replace history so back-button doesn't
        // re-trigger the import.
        navigate('/', { replace: true });
      } catch (e) {
        if (cancelled) return;
        const code = (e as Error & { code?: string }).code || 'parse_failed';
        const message =
          (e as Error).message || 'Something went wrong importing this feed.';
        // Map raw GTFS-parse failures to the spec's "looks like a ZIP but not GTFS" message.
        if (code === 'parse_failed' || /required|missing|gtfs/i.test(message)) {
          setError({
            code: 'not_gtfs',
            message: "We got a ZIP but it doesn't look like a valid GTFS feed.",
          });
        } else {
          setError({ code, message });
        }
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-cream flex flex-col">
      <header className="h-14 bg-white border-b border-sand flex items-center px-3 sm:px-5 shrink-0">
        <AppBrand mode="link" showTagline={false} />
      </header>

      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-lg bg-white border border-sand rounded-2xl p-8 shadow-sm">
          {status !== 'error' ? (
            <LoadingPanel
              status={status}
              sourceDescription={sourceDescription}
              partner={resolvePartnerLabel(source, ref)}
            />
          ) : (
            <ErrorPanel error={error!} onUploadFallback={() => navigate('/')} />
          )}
        </div>
      </main>
    </div>
  );
}

function LoadingPanel({
  status,
  sourceDescription,
  partner,
}: {
  status: 'loading' | 'parsing' | 'done';
  sourceDescription: string;
  partner: string | null;
}) {
  const verb = status === 'parsing' ? 'Parsing' : 'Loading';
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-full border-2 border-sand border-t-coral animate-spin" />
        <h1 className="font-heading font-bold text-xl text-dark-brown">
          {verb} feed…
        </h1>
      </div>
      {sourceDescription && (
        <p className="text-sm text-warm-gray mb-2">
          From <span className="font-mono text-dark-brown">{sourceDescription}</span>
        </p>
      )}
      {partner && (
        <p className="text-xs text-warm-gray">
          Sent here from <strong className="text-dark-brown">{partner}</strong>.
        </p>
      )}
    </div>
  );
}

function ErrorPanel({
  error,
  onUploadFallback,
}: {
  error: ImportErrorPayload;
  onUploadFallback: () => void;
}) {
  const cta = pathForward(error.code);
  return (
    <div>
      <h1 className="font-heading font-bold text-xl text-dark-brown mb-2">
        Couldn't import that feed
      </h1>
      <p className="text-sm text-warm-gray mb-5">{error.message}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          onClick={onUploadFallback}
          className="px-4 py-2.5 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors"
        >
          {cta.primary}
        </button>
        <Link
          to="/docs/deep-links/"
          className="px-4 py-2.5 rounded-lg font-heading font-bold text-sm border-2 border-sand text-dark-brown hover:bg-cream transition-colors text-center"
        >
          About deep-link imports
        </Link>
      </div>
      <p className="text-[11px] text-warm-gray mt-5 font-mono">
        Error code: {error.code}
      </p>
    </div>
  );
}

function pathForward(code: string): { primary: string } {
  switch (code) {
    case 'missing_url':
    case 'missing_feed_id':
    case 'invalid_url':
    case 'invalid_feed_id':
      return { primary: 'Open the editor and upload manually' };
    case 'fetch_timeout':
    case 'fetch_failed':
    case 'catalog_unavailable':
      return { primary: 'Open the editor and paste a feed URL' };
    case 'not_zip':
    case 'not_gtfs':
    case 'too_large':
      return { primary: 'Open the editor and upload manually' };
    case 'catalog_not_found':
      return { primary: 'Open the editor and try another feed' };
    case 'private_host':
      return { primary: 'Open the editor' };
    default:
      return { primary: 'Open the editor' };
  }
}
