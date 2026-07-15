import { useState } from 'react';
import { useStore } from '../../store';

// NTD / P-50 helper.
//
// FTA proposed requiring `agency_id` to equal the agency's NTD ID, withdrew the
// requirement (July 2025), and instead crosswalks published feeds → NTD IDs on
// its own via the enhanced P-50 (Transit Agency Identification) form. That form
// asks for the feed's stable URL plus, for every agency in the feed, its
// agency_id / agency_name and NTD ID. This panel lays out exactly those values,
// copy-ready, for a feed that is already published.
//
// Everything here is read from state we already have: each agency's own
// `external_id` (its NTD ID — a string whose leading zeros are significant)
// lives on the Agency entity and is edited in the Agency panel, so a
// multi-agency feed carries a different ID per agency. No new backend endpoint.

function CopyButton({
  value,
  label,
  ariaLabel,
}: {
  value: string;
  label: string;
  ariaLabel: string;
}) {
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
    <button
      onClick={copy}
      aria-label={ariaLabel}
      className={`text-[11px] px-2 py-1 rounded-md transition-colors whitespace-nowrap ${
        copied ? 'bg-teal text-white' : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
      }`}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-xs text-dark-brown bg-cream px-2 py-1 rounded break-all flex-1 font-mono">
          {value}
        </code>
        <CopyButton value={value} label="Copy" ariaLabel={`Copy ${label}`} />
      </div>
    </div>
  );
}

export function NtdP50Panel({ canonicalUrl }: { canonicalUrl: string | null }) {
  const agencies = useStore((s) => s.agencies);

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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray">
                  <tr>
                    <th className="px-2 py-1">agency_id</th>
                    <th className="px-2 py-1">agency_name</th>
                    <th className="px-2 py-1">NTD / external ID</th>
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
                      <td className="px-2 py-1.5 break-all">
                        {a.external_id ? (
                          <span className="font-mono text-xs text-dark-brown">{a.external_id}</span>
                        ) : (
                          <span className="text-[11px] text-warm-gray italic">
                            Not set — add it in the Agency panel
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        <span className="inline-flex gap-1">
                          <CopyButton
                            value={a.agency_id}
                            label="Copy ID"
                            ariaLabel={`Copy agency_id ${a.agency_id}`}
                          />
                          <CopyButton
                            value={a.agency_name}
                            label="Copy name"
                            ariaLabel={`Copy agency_name ${a.agency_name}`}
                          />
                          {a.external_id && (
                            <CopyButton
                              value={a.external_id}
                              label="Copy NTD"
                              ariaLabel={`Copy NTD / external ID ${a.external_id}`}
                            />
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-[11px] text-warm-gray">
          Keep your <code className="font-mono">agency_id</code> values stable across publishes —
          FTA's crosswalk is matched on them. Each agency's NTD ID is set on the agency itself and
          exported as an <code className="font-mono">external_id</code> column on{' '}
          <code className="font-mono">agency.txt</code>. Look an NTD ID up at{' '}
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
