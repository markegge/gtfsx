import type { StateCreator } from 'zustand';

export interface ProjectSlice {
  projectId: string;
  projectName: string;
  lastSavedAt: number | null;
  isDirty: boolean;
  setProjectName: (name: string) => void;
  markDirty: () => void;
  markSaved: () => void;
  setProjectId: (id: string) => void;
}

export const createProjectSlice: StateCreator<ProjectSlice, [['zustand/immer', never]], [], ProjectSlice> = (set) => ({
  projectId: crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  projectName: 'Untitled Feed',
  lastSavedAt: null,
  isDirty: false,
  setProjectName: (name) => set((state) => { state.projectName = name; state.isDirty = true; }),
  markDirty: () => set((state) => { state.isDirty = true; }),
  markSaved: () => set((state) => { state.isDirty = false; state.lastSavedAt = Date.now(); }),
  setProjectId: (id) => set((state) => { state.projectId = id; }),
});
