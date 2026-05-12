import { useCallback, useState } from 'react';

interface MdLocation {
  country_code?: string;
  country?: string;
  subdivision_name?: string;
  municipality?: string;
}

export interface CatalogFeed {
  id: string;
  provider: string;
  feed_name?: string;
  note?: string;
  locations?: MdLocation[];
  source_info?: { producer_url?: string };
  latest_dataset?: {
    id: string;
    hosted_url?: string;
    downloaded_at?: string;
  };
}

interface Props {
  onSelect: (feed: CatalogFeed, fileName: string) => Promise<void>;
}

const SEARCH_URL = `${window.location.origin}/_import/search`;

function summarizeLocations(locations?: MdLocation[]): string {
  if (!locations || locations.length === 0) return '';
  const seen = new Set<string>();
  for (const l of locations) {
    const parts = [l.subdivision_name, l.country_code].filter(Boolean);
    if (parts.length) seen.add(parts.join(', '));
    if (seen.size >= 3) break;
  }
  return [...seen].join(' · ');
}

function summarizeProvider(provider: string): string {
  // Some MD entries are giant comma-joined operator lists. Truncate so the row
  // doesn't blow up the layout.
  if (provider.length <= 60) return provider;
  const first = provider.split(',')[0].trim();
  return `${first} +${provider.split(',').length - 1} more`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function CatalogSearch({ onSelect }: Props) {
  const [provider, setProvider] = useState('');
  const [country, setCountry] = useState('US');
  const [subdivision, setSubdivision] = useState('');

  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<CatalogFeed[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const search = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    setResults(null);
    try {
      const params = new URLSearchParams();
      if (provider.trim()) params.set('provider', provider.trim());
      if (country.trim()) params.set('country_code', country.trim().toUpperCase());
      if (subdivision.trim()) params.set('subdivision_name', subdivision.trim());
      params.set('limit', '50');
      const r = await fetch(`${SEARCH_URL}?${params.toString()}`);
      if (!r.ok) throw new Error(`Search failed: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { results: CatalogFeed[] };
      setResults(j.results || []);
    } catch (e: any) {
      setSearchError(e.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  }, [provider, country, subdivision]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search();
  };

  const handleImport = async (feed: CatalogFeed) => {
    if (!feed.latest_dataset?.hosted_url) {
      setImportError('That feed has no hosted dataset URL.');
      return;
    }
    setImportError(null);
    setImportingId(feed.id);
    try {
      const fileName = feed.provider.split(',')[0].trim().slice(0, 60).replace(/[\\/:*?"<>|]+/g, '_') || feed.id;
      await onSelect(feed, fileName);
    } catch (e: any) {
      setImportError(e.message || 'Import failed');
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* `autoComplete="off"` + the vendor-specific data attributes tell the
          common password managers (1Password / LastPass / Dashlane / Bitwarden)
          that these are search fields, not login/credential fields. Without
          them, 1Password in particular pops a "Save in 1Password" prompt
          over the agency-name input the first time you type into it. */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2"
        autoComplete="off"
        data-form-type="search"
      >
        <input
          autoFocus
          type="search"
          name="catalog-search-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="Agency or city (e.g. Streamline, Bozeman, SFMTA)"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          data-bwignore
          className="px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white focus:outline-none focus:border-coral"
        />
        <div className="flex gap-2">
          <input
            type="search"
            name="catalog-search-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Country (US)"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            data-bwignore
            className="w-20 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white focus:outline-none focus:border-coral uppercase"
          />
          <input
            type="search"
            name="catalog-search-region"
            value={subdivision}
            onChange={(e) => setSubdivision(e.target.value)}
            placeholder="State / region (optional)"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            data-bwignore
            className="flex-1 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white focus:outline-none focus:border-coral"
          />
          <button
            type="submit"
            disabled={searching}
            className="px-4 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {searchError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {searchError}
        </div>
      )}
      {importError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {importError}
        </div>
      )}

      {results && (
        <div className="border border-sand rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-cream text-[11px] font-semibold text-warm-gray uppercase tracking-wide flex items-center justify-between">
            <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
            {results.length === 50 && <span className="normal-case font-normal">showing first 50 — narrow your search</span>}
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-sand">
            {results.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-warm-gray">No feeds match those filters.</div>
            ) : (
              results.map((feed) => {
                const url = feed.latest_dataset?.hosted_url;
                const isImporting = importingId === feed.id;
                const disabled = !url || importingId !== null;
                return (
                  <button
                    key={feed.id}
                    onClick={() => handleImport(feed)}
                    disabled={disabled}
                    className="w-full text-left px-3 py-2.5 hover:bg-cream transition-colors disabled:hover:bg-transparent disabled:opacity-60 flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-dark-brown truncate">{summarizeProvider(feed.provider)}</div>
                      {feed.feed_name && (
                        <div className="text-xs text-warm-gray truncate">{feed.feed_name}</div>
                      )}
                      <div className="text-[11px] text-warm-gray flex items-center gap-2 mt-0.5">
                        {summarizeLocations(feed.locations)}
                        {feed.latest_dataset?.downloaded_at && (
                          <span className="text-warm-gray/80">· updated {fmtDate(feed.latest_dataset.downloaded_at)}</span>
                        )}
                        {!url && <span className="text-amber-600">· no dataset available</span>}
                      </div>
                    </div>
                    <div className="text-xs text-coral font-semibold whitespace-nowrap pt-0.5">
                      {isImporting ? 'Loading…' : 'Import →'}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-warm-gray/80">
        Catalog data via{' '}
        <a href="https://mobilitydatabase.org/" target="_blank" rel="noopener" className="text-warm-gray hover:text-coral underline">
          mobilitydatabase.org
        </a>
        . Feeds are downloaded through this site to bypass CORS; large feeds may take a moment.
      </p>
    </div>
  );
}
