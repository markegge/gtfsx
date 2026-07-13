import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Breadcrumb } from '../ui/Breadcrumb';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareMedia } from '../../types/gtfs';

const MEDIA_TYPES: { value: 0 | 1 | 2 | 3 | 4; label: string }[] = [
  { value: 0, label: 'None (cash / equivalent)' },
  { value: 1, label: 'Physical paper ticket' },
  { value: 2, label: 'Physical transit card' },
  { value: 3, label: 'Contactless (cEMV)' },
  { value: 4, label: 'Mobile app' },
];

const mediaTypeLabel = (t: number) =>
  MEDIA_TYPES.find((m) => m.value === t)?.label ?? `Type ${t}`;

/**
 * GTFS-Fares v2 Fare Media editor (fare_media.txt). A fare medium is the
 * payment method a product is bought/validated on (cash, paper ticket, transit
 * card, contactless, mobile). fare_media_id is unique and required;
 * fare_media_type is required. Fare products reference a medium.
 */
export function FareMediaEditor() {
  const fareMedia = useStore((s) => s.fareMedia);
  const addFareMediaItem = useStore((s) => s.addFareMediaItem);
  const updateFareMediaItem = useStore((s) => s.updateFareMediaItem);
  const renameFareMediaId = useStore((s) => s.renameFareMediaId);
  const removeFareMediaItem = useStore((s) => s.removeFareMediaItem);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();

  const selected = fareMedia.find((m) => m.fare_media_id === selectedId) ?? null;

  const open = (id: string | null) => {
    setSelectedId(id);
    const m = fareMedia.find((x) => x.fare_media_id === id);
    setIdDraft(m?.fare_media_id ?? '');
    setIdError(undefined);
  };

  const handleAdd = () => {
    const media: FareMedia = { fare_media_id: generateId('media'), fare_media_type: 0 };
    addFareMediaItem(media);
    open(media.fare_media_id);
  };

  const commitId = () => {
    if (!selected) return;
    const next = idDraft.trim();
    if (!next) {
      setIdError('Fare media ID is required.');
      setIdDraft(selected.fare_media_id);
      return;
    }
    if (next === selected.fare_media_id) { setIdError(undefined); return; }
    if (fareMedia.some((m) => m.fare_media_id === next)) {
      setIdError(`Fare media ID "${next}" is already in use.`);
      return;
    }
    renameFareMediaId(selected.fare_media_id, next);
    setSelectedId(next);
    setIdError(undefined);
  };

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            <strong>Fare media</strong> are the ways a rider pays or validates — cash, a paper
            ticket, a transit card, contactless, or a mobile app. Fare products reference a medium.
          </p>
        </div>

        <RailSubHeading count={fareMedia.length}>Fare Media</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {fareMedia.map((m) => (
            <button
              key={m.fare_media_id}
              onClick={() => open(m.fare_media_id)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">
                  {m.fare_media_name || m.fare_media_id}
                </span>
                <span className="text-[11px] text-warm-gray shrink-0">{mediaTypeLabel(m.fare_media_type)}</span>
              </div>
              <div className="text-[11px] text-warm-gray mt-0.5 font-mono">{m.fare_media_id}</div>
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add Fare Media
        </button>
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray mb-1">
        <Breadcrumb
          items={[
            { label: 'Fare Media', onClick: () => open(null) },
            { label: selected.fare_media_name || selected.fare_media_id, className: 'truncate' },
          ]}
        />
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          {selected.fare_media_name || selected.fare_media_id}
        </h2>
        <EditActions
          onDelete={() => { removeFareMediaItem(selected.fare_media_id); open(null); }}
          deleteTitle="Delete this fare medium"
        />
      </div>

      <FormField
        label="Fare Media ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder="fare_media_id"
        required
        error={idError}
      />
      {idDraft.trim() !== selected.fare_media_id && (
        <button
          onClick={commitId}
          className="mb-4 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          Rename to “{idDraft.trim() || '…'}”
        </button>
      )}

      <FormField
        label="Fare Media Name"
        value={selected.fare_media_name ?? ''}
        onChange={(v) => updateFareMediaItem(selected.fare_media_id, { fare_media_name: v || undefined })}
        placeholder="e.g. Contactless Card (optional)"
      />

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Fare Media Type <span className="text-coral">*</span>
        </label>
        <select
          value={selected.fare_media_type}
          onChange={(e) => updateFareMediaItem(selected.fare_media_id, {
            fare_media_type: Number(e.target.value) as 0 | 1 | 2 | 3 | 4,
          })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          {MEDIA_TYPES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
