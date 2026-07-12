import { useState } from 'react';
import { useStore } from '../../store';

// NTD / P-50 helper.
//
// FTA proposed requiring `agency_id` to equal the agency's NTD ID, withdrew the
// requirement (July 2025), and instead crosswalks published feeds → NTD IDs on
// its own via the enhanced P-50 (Transit Agency Identification) form. That form
// asks for the feed's stable URL plus the agency_id / agency_name pairs inside
// it. This panel lays out exactly those values, copy-ready, for a feed that is
// already published.
//
// Everything here is read from state we already have — the editor store's
// agencies + ntdId and the existing publication info. No new backend endpoint.

function CopyValue({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions) — the value is
      // selectable on screen, so there's nothing to recover from.
    }
  };
  return (
    <div>
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code
          className={`text-xs text-dark-brown bg-cream px-2 py-1 rounded break-all flex-1 ${
            mono ? 'font-mono' : ''
          }`}
        >
          {value}
        </code>
        <button
          onClick={copy}
          aria-label={`Copy ${label}`}
          className={`text-xs px-2 py-1 rounded-md transition-colors whitespace-nowrap ${
            copied ? 'bg-teal text-white' : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
          }`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function NtdP50Panel({ canonicalUrl }: { canonicalUrl: string | null }) {
  const agencies = useStore((s) => s.agencies);
  // String, never a number — NTD IDs carry significant leading zeros.
  const ntdId = useStore((s) => s.ntdId);

  const multiAgency = agencies.length > 1;

  return (
    <section className="bg-white border border-sand rounded-xl p-4">
      <h3 className="font-heading font-bold text-base text-dark-brown mb-1">
        NTD / FTA P-50 reporting
      </h3>
      <p className="text-sm text-warm-gray mb-4">
        FTA crosswalks published GTFS feeds to National Transit Database IDs through the enhanced
        P-50 form. These are the values that form asks for — copy them straight across.
      </p>

      <div className="space-y-3">
        <CopyValue label="NTD ID" value={ntdId ?? 'Not set — add it above before publishing'} />
        {canonicalUrl ? (
          <CopyValue label="Feed URL (stable, canonical)" value={canonicalUrl} />
        ) : (
          <div className="text-xs text-warm-gray">
            Publish this feed to get a stable canonical URL for the P-50 form.
          </div>
        )}

        <div>
          <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Agencies in this feed ({agencies.length})
          </div>
          {agencies.length === 0 ? (
            <p className="text-xs text-warm-gray">
              This feed has no agencies yet — add one in the Agency tab.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray">
                <tr>
                  <th className="px-2 py-1">agency_id</th>
                  <th className="px-2 py-1">agency_name</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {agencies.map((a) => (
                  <tr key={a.agency_id} className="border-t border-sand align-middle">
                    <td className="px-2 py-1.5 font-mono text-xs text-dark-brown break-all">
                      {a.agency_id}
                    </td>
                    <td className="px-2 py-1.5 text-dark-brown">{a.agency_name}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <AgencyCopyButtons agencyId={a.agency_id} agencyName={a.agency_name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {multiAgency && (
          <div className="px-3 py-2 rounded-md bg-gold-light border border-gold text-amber-800 text-xs">
            <span className="font-semibold">This feed contains {agencies.length} agencies.</span>{' '}
            The NTD ID above identifies the <em>reporting</em> agency for the feed as a whole —
            GTFS·X does not yet model a separate NTD ID per agency, so don't assume it applies to
            every agency listed here. If several of these agencies report to NTD separately, give
            FTA each agency's own NTD ID alongside its agency_id on the P-50 form.
          </div>
        )}

        <p className="text-[11px] text-warm-gray">
          Keep your <code className="font-mono">agency_id</code> values stable across publishes —
          FTA's crosswalk is matched on them. Look your NTD ID up at{' '}
          <a
            href="https://www.transit.dot.gov/ntd"
            target="_blank"
            rel="noopener noreferrer"
            className="text-coral hover:underline"
          >
            transit.dot.gov/ntd
          </a>
          .
        </p>
      </div>
    </section>
  );
}

function AgencyCopyButtons({ agencyId, agencyName }: { agencyId: string; agencyName: string }) {
  const [copied, setCopied] = useState<'id' | 'name' | null>(null);
  const copy = async (what: 'id' | 'name', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Ignore — the value is on screen and selectable.
    }
  };
  const cls = (active: boolean) =>
    `text-[11px] px-2 py-1 rounded-md transition-colors whitespace-nowrap ${
      active ? 'bg-teal text-white' : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
    }`;
  return (
    <span className="inline-flex gap-1">
      <button
        onClick={() => copy('id', agencyId)}
        aria-label={`Copy agency_id ${agencyId}`}
        className={cls(copied === 'id')}
      >
        {copied === 'id' ? 'Copied!' : 'Copy ID'}
      </button>
      <button
        onClick={() => copy('name', agencyName)}
        aria-label={`Copy agency_name ${agencyName}`}
        className={cls(copied === 'name')}
      >
        {copied === 'name' ? 'Copied!' : 'Copy name'}
      </button>
    </span>
  );
}
