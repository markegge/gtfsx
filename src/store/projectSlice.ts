import type { StateCreator } from 'zustand';

export interface ProjectSlice {
  projectId: string;
  projectName: string;
  lastSavedAt: number | null;
  isDirty: boolean;
  // The project's FTA National Transit Database ID. NTD IDs are 5-digit
  // strings with significant leading zeros (e.g. "00123") — never coerce
  // through Number() anywhere this is read or written. This is feed-state
  // (like projectName), not GTFS spec data, so it is NOT written into the
  // export zip unless exportNtdIdColumn opts in.
  ntdId: string | null;
  // Opt-in: write an `ext_ntd_id` column on agency.txt at export time.
  exportNtdIdColumn: boolean;
  // SPDX short identifier for the feed's declared license (e.g. "CC-BY-4.0"),
  // or null when unset. Feed state exactly like ntdId: the store is the source
  // of truth and the D1 `license_spdx` column is only a projection written at
  // publish, so a license picked before the first publish survives a reload and
  // is available outside the publish flow.
  licenseSpdx: string | null;
  setProjectName: (name: string) => void;
  markDirty: () => void;
  markSaved: () => void;
  setProjectId: (id: string) => void;
  setNtdId: (value: string | null) => void;
  setExportNtdIdColumn: (enabled: boolean) => void;
  setLicenseSpdx: (value: string | null) => void;
}

export const createProjectSlice: StateCreator<ProjectSlice, [['zustand/immer', never]], [], ProjectSlice> = (set) => ({
  projectId: crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  projectName: 'Untitled Feed',
  lastSavedAt: null,
  isDirty: false,
  ntdId: null,
  exportNtdIdColumn: false,
  licenseSpdx: null,
  setProjectName: (name) => set((state) => {
    if (state.projectName === name) return;
    state.projectName = name;
    state.isDirty = true;
  }),
  markDirty: () => set((state) => { state.isDirty = true; }),
  markSaved: () => set((state) => { state.isDirty = false; state.lastSavedAt = Date.now(); }),
  setProjectId: (id) => set((state) => { state.projectId = id; }),
  setNtdId: (value) => set((state) => {
    // Trim whitespace; treat empty string as null. Never coerce with Number()
    // — leading zeros are significant in NTD IDs.
    const trimmed = value?.trim() ?? '';
    const normalized = trimmed === '' ? null : trimmed;
    if (state.ntdId === normalized) return;
    state.ntdId = normalized;
    state.isDirty = true;
  }),
  setExportNtdIdColumn: (enabled) => set((state) => {
    if (state.exportNtdIdColumn === enabled) return;
    state.exportNtdIdColumn = enabled;
    state.isDirty = true;
  }),
  setLicenseSpdx: (value) => set((state) => {
    // Same normalization as setNtdId: trim, empty string → null (the "Not
    // specified" option in the publish panel's select sends '').
    const trimmed = value?.trim() ?? '';
    const normalized = trimmed === '' ? null : trimmed;
    if (state.licenseSpdx === normalized) return;
    state.licenseSpdx = normalized;
    state.isDirty = true;
  }),
});
