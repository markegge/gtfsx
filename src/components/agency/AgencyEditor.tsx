import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { EmptyState } from '../ui/EmptyState';
import { EditActions } from '../ui/EditActions';
import { RailSubHeading, RailDivider } from '../ui/RailHeadings';
import { US_TIMEZONES } from '../../utils/constants';
import { agencyReferenceCount, newAgencyDraft } from './agencyHelpers';
import type { Agency } from '../../types/gtfs';

/**
 * agency.txt editor. A feed usually has exactly one agency, so that case looks
 * like a plain form — but joint feeds (two operators publishing together) are
 * legitimate GTFS, and every agency needs its own fields, its own `agency_id`,
 * and its own NTD / external id. So the panel manages the whole list:
 *
 *  - 1 agency  → the form, plus "+ Add Agency". No selector, no delete (GTFS
 *                requires at least one agency; deleting the only one is not a
 *                thing users want a button for).
 *  - 2+        → an "Editing" picker above the form (a select rather than the
 *                list → detail view the Routes/Fares panels use: an agency is a
 *                short form, not a sub-tree, and a feed has two or three of
 *                them, so a dropdown keeps the fields one click away), plus a
 *                Delete for the selected agency when nothing references it.
 *
 * Rows are addressed by INDEX, not by agency_id: agency_id is only conditionally
 * required by the spec, so an imported feed can carry blank or duplicate ids and
 * an id-addressed update would edit the wrong agency (see `updateAgencyAt`).
 */
export function AgencyEditor() {
  const {
    agencies, addAgency, updateAgencyAt, renameAgencyIdAt, removeAgencyAt,
    routes, fareAttributes,
    feedInfo, updateFeedInfo,
  } = useStore();

  const [selectedIndex, setSelectedIndex] = useState(0);
  // agency_id edits are committed explicitly (draft + a confirm button), not on
  // every keystroke — the rename cascades to routes.txt and fare_attributes.txt,
  // and rewriting those references per character would be wrong. Same pattern as
  // the Fares v2 id editors.
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();

  const [idDraftFor, setIdDraftFor] = useState<{ index: number; id: string } | null>(null);

  // The selection is an index, so it can dangle after a delete or an import.
  const index = selectedIndex < agencies.length ? selectedIndex : 0;
  const agency = agencies[index] ?? null;
  const currentAgencyId = agency?.agency_id ?? '';

  // Re-seed the id draft whenever the selection lands on a different agency (or
  // the feed underneath is replaced by an import). Reconciled during render (the
  // pattern CalendarEditor uses for its pending-confirm state) rather than in an
  // effect. Typing only moves the draft, never `currentAgencyId`, so a half-typed
  // id is never clobbered.
  if (!idDraftFor || idDraftFor.index !== index || idDraftFor.id !== currentAgencyId) {
    setIdDraftFor({ index, id: currentAgencyId });
    setIdDraft(currentAgencyId);
    setIdError(undefined);
  }

  const handleAdd = () => {
    addAgency(newAgencyDraft(agencies));
    setSelectedIndex(agencies.length); // the row we just pushed
  };

  if (!agency) {
    return (
      <EmptyState
        icon="🏢"
        title="No agency defined"
        description="Add your transit agency to get started."
        actionLabel="Add Agency"
        onAction={handleAdd}
      />
    );
  }

  const multi = agencies.length > 1;
  const label = (a: Agency, i: number) => a.agency_name || a.agency_id || `Agency ${i + 1}`;

  const commitId = () => {
    const next = idDraft.trim();
    if (next === currentAgencyId) { setIdError(undefined); return; }
    if (!next && multi) {
      setIdError('agency_id is required when the feed has more than one agency.');
      return;
    }
    if (next && agencies.some((a, i) => i !== index && a.agency_id === next)) {
      setIdError(`Agency ID "${next}" is already used by another agency.`);
      return;
    }
    renameAgencyIdAt(index, next);
    setIdError(undefined);
  };

  // Deleting an agency does not cascade — a route pointing at a vanished
  // agency_id is a broken feed. So the delete is offered only when nothing
  // references this agency, and otherwise we say what is in the way.
  const refs = agencyReferenceCount(agency, routes, fareAttributes);
  const canDelete = multi && refs.total === 0;
  const blockedReason = multi && refs.total > 0
    ? `Can't delete this agency: ${[
        refs.routes > 0 ? `${refs.routes} route${refs.routes === 1 ? '' : 's'}` : null,
        refs.fares > 0 ? `${refs.fares} fare${refs.fares === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' and ')} still belong to it. Reassign them (Routes › Details › Operated by) first.`
    : null;

  return (
    <div>
      {multi && (
        <>
          <RailSubHeading count={agencies.length}>Agencies</RailSubHeading>
          <div className="mb-3 flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="agency-picker"
                className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1"
              >
                Editing
              </label>
              <select
                id="agency-picker"
                value={index}
                onChange={(e) => setSelectedIndex(Number(e.target.value))}
                className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
              >
                {agencies.map((a, i) => (
                  <option key={i} value={i}>{label(a, i)}</option>
                ))}
              </select>
            </div>
            {canDelete && (
              <div className="pb-0.5">
                <EditActions
                  onDelete={() => { removeAgencyAt(index); setSelectedIndex(0); }}
                  deleteTitle="Delete this agency"
                />
              </div>
            )}
          </div>
          {blockedReason && (
            <p className="mb-3 text-[11px] text-warm-gray leading-snug">{blockedReason}</p>
          )}
        </>
      )}

      {/* agency_id. Optional in a single-agency feed (spec-legal to omit, though
          FTA can't crosswalk a feed without one), REQUIRED once the feed has more
          than one agency — and it's what routes.txt points at, so a change here
          is a rename, committed on the button below. */}
      <FormField
        label="Agency ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder={multi ? 'e.g. SVT' : 'e.g. SVT (optional)'}
        required={multi}
        error={idError}
      />
      {idDraft.trim() !== currentAgencyId && (
        <button
          onClick={commitId}
          className="mb-3 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          {currentAgencyId
            ? `Rename to “${idDraft.trim() || '(blank)'}” and update its routes`
            : `Set ID to “${idDraft.trim() || '(blank)'}”`}
        </button>
      )}

      <FormField
        label="Agency Name"
        value={agency.agency_name}
        onChange={(v) => updateAgencyAt(index, { agency_name: v })}
        placeholder="e.g., Streamline Transit"
        required
      />
      <FormField
        label="Agency URL"
        value={agency.agency_url}
        onChange={(v) => updateAgencyAt(index, { agency_url: v })}
        placeholder="https://..."
        required
      />
      <FormField label="Timezone" required>
        <select
          value={agency.agency_timezone}
          onChange={(e) => updateAgencyAt(index, { agency_timezone: e.target.value })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          {US_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          label="Phone"
          value={agency.agency_phone || ''}
          onChange={(v) => updateAgencyAt(index, { agency_phone: v })}
          placeholder="(555) 123-4567"
        />
        <FormField
          label="Email"
          value={agency.agency_email || ''}
          onChange={(v) => updateAgencyAt(index, { agency_email: v })}
          placeholder="info@agency.com"
        />
      </div>
      <FormField
        label="Language"
        value={agency.agency_lang || 'en-US'}
        onChange={(v) => updateAgencyAt(index, { agency_lang: v })}
      />

      {/* The agency's external identifier — in the US, its FTA National Transit
          Database (NTD) ID. Free-form on purpose: it carries significant leading
          zeros ("01234") and may hold a non-NTD identifier, so it is stored and
          exported as a STRING and never format-checked or Number()-coerced.
          Per-agency: a joint feed's operators report to the NTD separately, so
          each row gets its own value. Exported as an `external_id` column on
          agency.txt whenever any agency has one. Hand-rolled rather than
          <FormField> only because the label carries the docs link. */}
      <div className="mb-3">
        <label
          htmlFor="agency-external-id"
          className="flex items-center gap-1.5 text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1"
        >
          NTD / External ID
          <a
            href="/docs/ntd-id/"
            target="_blank"
            rel="noopener noreferrer"
            title="What is an NTD / External ID?"
            aria-label="What is an NTD / External ID? Opens the docs in a new tab"
            className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-warm-gray/50 text-[9px] font-bold not-italic normal-case text-warm-gray hover:border-coral hover:text-coral transition-colors"
          >
            i
          </a>
        </label>
        <input
          id="agency-external-id"
          type="text"
          autoComplete="off"
          placeholder="e.g. 01234"
          value={agency.external_id ?? ''}
          onChange={(e) => {
            const trimmed = e.target.value.trim();
            updateAgencyAt(index, { external_id: trimmed === '' ? undefined : trimmed });
          }}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm font-mono text-dark-brown bg-cream transition-colors focus:outline-none focus:border-coral focus:bg-white"
        />
      </div>

      <button
        onClick={handleAdd}
        className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
      >
        + Add Agency
      </button>

      <RailDivider />
      <RailSubHeading>Feed Info</RailSubHeading>
      {/* feed_publisher is fixed to GTFS·X on every export and publish (see
          gtfsExport buildFeedInfoRow). The prior/imported publisher is shown
          here read-only for reference but is never written to the exported
          feed_info.txt. */}
      <FormField
        label="Prior publisher"
        value={feedInfo?.feed_publisher_name || ''}
        onChange={() => {}}
        disabled
        placeholder="None — published as GTFS·X"
      />
      <FormField
        label="Prior publisher URL"
        value={feedInfo?.feed_publisher_url || ''}
        onChange={() => {}}
        disabled
        placeholder="None — published as GTFS·X"
      />
      <FormField
        label="Feed Language"
        value={feedInfo?.feed_lang || 'en-US'}
        onChange={(v) => updateFeedInfo({ feed_lang: v })}
      />
      <FormField
        label="Feed Version"
        value={feedInfo?.feed_version || ''}
        onChange={(v) => updateFeedInfo({ feed_version: v })}
        placeholder="e.g., 2026-03"
      />
    </div>
  );
}
