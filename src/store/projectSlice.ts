import type { StateCreator } from 'zustand';

export interface ProjectSlice {
  projectId: string;
  projectName: string;
  lastSavedAt: number | null;
  isDirty: boolean;
  // SPDX short identifier for the feed's declared license (e.g. "CC-BY-4.0"),
  // or null when unset. This is feed state: the store is the source of truth and
  // the D1 `license_spdx` column is only a projection written at publish, so a
  // license picked before the first publish survives a reload and is available
  // outside the publish flow.
  //
  // (An agency's NTD / external ID is NOT here — it belongs to the Agency
  // entity as `external_id` and rides along with agencies. See types/gtfs.ts.)
  licenseSpdx: string | null;
  setProjectName: (name: string) => void;
  markDirty: () => void;
  markSaved: () => void;
  setProjectId: (id: string) => void;
  setLicenseSpdx: (value: string | null) => void;
}

export const createProjectSlice: StateCreator<ProjectSlice, [['zustand/immer', never]], [], ProjectSlice> = (set) => ({
  projectId: crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  projectName: 'Untitled Feed',
  lastSavedAt: null,
  isDirty: false,
  licenseSpdx: null,
  setProjectName: (name) => set((state) => {
    if (state.projectName === name) return;
    state.projectName = name;
    state.isDirty = true;
  }),
  markDirty: () => set((state) => { state.isDirty = true; }),
  markSaved: () => set((state) => { state.isDirty = false; state.lastSavedAt = Date.now(); }),
  setProjectId: (id) => set((state) => { state.projectId = id; }),
  setLicenseSpdx: (value) => set((state) => {
    // Trim; empty string → null (the "Not specified" option in the publish
    // panel's select sends '').
    const trimmed = value?.trim() ?? '';
    const normalized = trimmed === '' ? null : trimmed;
    if (state.licenseSpdx === normalized) return;
    state.licenseSpdx = normalized;
    state.isDirty = true;
  }),
});
