import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Badge } from '../ui/Badge';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareArea } from '../../types/gtfs';

/**
 * GTFS-Fares v2 Areas editor (areas.txt + stop_areas.txt). Phase 1 of the v2
 * authoring epic (#32). Lets the user:
 *   • create / rename / delete areas (area_id unique, area_name optional)
 *   • assign stops to an area and remove them (stop_areas.txt)
 *
 * Later v2 editors (networks, rider categories, fare media/products,
 * timeframes, leg/transfer rules) are deferred to follow-up phases.
 */
export function AreasEditor() {
  const fareAreas = useStore((s) => s.fareAreas);
  const stopAreas = useStore((s) => s.stopAreas);
  const stops = useStore((s) => s.stops);
  const addFareArea = useStore((s) => s.addFareArea);
  const updateFareArea = useStore((s) => s.updateFareArea);
  const renameFareAreaId = useStore((s) => s.renameFareAreaId);
  const removeFareArea = useStore((s) => s.removeFareArea);
  const addStopToArea = useStore((s) => s.addStopToArea);
  const removeStopFromArea = useStore((s) => s.removeStopFromArea);

  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  // Local draft of the editable area_id, committed on blur (renames cascade to
  // stop_areas). Kept separate from the store so mid-edit values don't churn
  // the mapping rows on every keystroke.
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();
  const [stopFilter, setStopFilter] = useState('');

  const selectedArea = fareAreas.find((a) => a.area_id === selectedAreaId) ?? null;

  // stop_id → count of areas it belongs to (a stop may be in many areas).
  const stopCountByArea = useMemo(() => {
    const m = new Map<string, number>();
    for (const sa of stopAreas) m.set(sa.area_id, (m.get(sa.area_id) ?? 0) + 1);
    return m;
  }, [stopAreas]);

  const stopName = (stopId: string) =>
    stops.find((s) => s.stop_id === stopId)?.stop_name || stopId;

  const openArea = (id: string | null) => {
    setSelectedAreaId(id);
    const a = fareAreas.find((x) => x.area_id === id);
    setIdDraft(a?.area_id ?? '');
    setIdError(undefined);
    setStopFilter('');
  };

  const handleAddArea = () => {
    const area: FareArea = { area_id: generateId('area') };
    addFareArea(area);
    openArea(area.area_id);
  };

  const commitId = () => {
    if (!selectedArea) return;
    const next = idDraft.trim();
    if (!next) {
      setIdError('Area ID is required.');
      setIdDraft(selectedArea.area_id);
      return;
    }
    if (next === selectedArea.area_id) {
      setIdError(undefined);
      return;
    }
    if (fareAreas.some((a) => a.area_id === next)) {
      setIdError(`Area ID "${next}" is already in use.`);
      return;
    }
    renameFareAreaId(selectedArea.area_id, next);
    setSelectedAreaId(next);
    setIdError(undefined);
  };

  // Stops assigned to the selected area, and stops still available to add.
  const assignedStopIds = selectedArea
    ? stopAreas.filter((sa) => sa.area_id === selectedArea.area_id).map((sa) => sa.stop_id)
    : [];
  const assignedSet = new Set(assignedStopIds);
  const filterLc = stopFilter.trim().toLowerCase();
  const availableStops = selectedArea
    ? stops
        .filter((s) => !assignedSet.has(s.stop_id))
        .filter(
          (s) =>
            !filterLc ||
            (s.stop_name || '').toLowerCase().includes(filterLc) ||
            s.stop_id.toLowerCase().includes(filterLc),
        )
        .slice(0, 50)
    : [];

  // ── List view ───────────────────────────────────────────────────────────
  if (!selectedArea) {
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            Fare <strong>areas</strong> group stops for GTFS-Fares v2 pricing (areas.txt + stop_areas.txt).
            Create an area, then assign the stops it covers. Leg rules (a later phase) reference these areas.
          </p>
        </div>

        <RailSubHeading count={fareAreas.length}>Fare Areas</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {fareAreas.map((area) => {
            const count = stopCountByArea.get(area.area_id) ?? 0;
            return (
              <button
                key={area.area_id}
                onClick={() => openArea(area.area_id)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">
                    {area.area_name || area.area_id}
                  </span>
                  <Badge variant={count > 0 ? 'info' : 'warning'}>
                    {count > 0 ? `${count} stop${count > 1 ? 's' : ''}` : 'No stops'}
                  </Badge>
                </div>
                {area.area_name && (
                  <div className="text-[11px] text-warm-gray mt-0.5 font-mono">{area.area_id}</div>
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={handleAddArea}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add Area
        </button>
      </div>
    );
  }

  // ── Detail view ─────────────────────────────────────────────────────────
  return (
    <div>
      {/* Breadcrumb */}
      <nav className="text-[13px] text-warm-gray flex items-center gap-1.5 mb-1">
        <button onClick={() => openArea(null)} className="hover:text-coral transition-colors">‹</button>
        <button onClick={() => openArea(null)} className="hover:text-coral transition-colors">Areas</button>
        <span className="opacity-50">›</span>
        <span className="text-dark-brown font-semibold truncate">
          {selectedArea.area_name || selectedArea.area_id}
        </span>
      </nav>

      {/* Title + actions */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          {selectedArea.area_name || selectedArea.area_id}
        </h2>
        <EditActions
          onDelete={() => {
            removeFareArea(selectedArea.area_id);
            openArea(null);
          }}
          deleteTitle="Delete this area"
        />
      </div>

      <FormField
        label="Area ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder="area_id"
        required
        error={idError}
      />

      <FormField
        label="Area Name"
        value={selectedArea.area_name ?? ''}
        onChange={(v) => updateFareArea(selectedArea.area_id, { area_name: v || undefined })}
        placeholder="e.g. Downtown Zone (optional)"
      />

      {/* Commit the area_id rename. Kept as an explicit button so a cascading
          rename (which rewrites stop_areas) is a deliberate action, not a
          surprise from losing focus. */}
      {idDraft.trim() !== selectedArea.area_id && (
        <button
          onClick={commitId}
          className="mb-4 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          Rename area to “{idDraft.trim() || '…'}”
        </button>
      )}

      <div className="h-px bg-sand my-4" />

      {/* Stop assignment */}
      <RailSubHeading count={assignedStopIds.length}>Stops in this area</RailSubHeading>

      {assignedStopIds.length === 0 ? (
        <p className="text-[12px] text-warm-gray mb-3">
          No stops assigned yet. Add stops below to build this area.
        </p>
      ) : (
        <div className="space-y-1 mb-3">
          {assignedStopIds.map((stopId) => (
            <div
              key={stopId}
              className="flex items-center justify-between px-3 py-2 bg-cream rounded-lg text-sm"
            >
              <span className="text-dark-brown truncate">{stopName(stopId)}</span>
              <button
                onClick={() => removeStopFromArea(selectedArea.area_id, stopId)}
                className="text-warm-gray hover:text-red-500 text-xs font-bold transition-colors shrink-0 ml-2"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add stops */}
      <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        Add stops
      </label>
      <input
        type="text"
        value={stopFilter}
        onChange={(e) => setStopFilter(e.target.value)}
        placeholder="Search stops by name or ID…"
        className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white mb-2"
      />
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {availableStops.length === 0 ? (
          <p className="text-[12px] text-warm-gray px-1 py-2">
            {stops.length === 0
              ? 'No stops in this feed yet — add stops in the Stops panel first.'
              : 'No matching stops.'}
          </p>
        ) : (
          availableStops.map((stop) => (
            <button
              key={stop.stop_id}
              onClick={() => addStopToArea(selectedArea.area_id, stop.stop_id)}
              className="w-full flex items-center justify-between px-3 py-2 bg-white border border-sand rounded-lg text-sm hover:border-coral hover:text-coral transition-colors"
            >
              <span className="text-dark-brown truncate">{stop.stop_name || stop.stop_id}</span>
              <span className="text-coral text-xs font-bold shrink-0 ml-2">+ Add</span>
            </button>
          ))
        )}
        {selectedArea && stops.filter((s) => !assignedSet.has(s.stop_id)).length > availableStops.length && (
          <p className="text-[11px] text-warm-gray px-1 py-1">
            Showing first {availableStops.length}. Refine your search to see more.
          </p>
        )}
      </div>
    </div>
  );
}
