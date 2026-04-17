import type { StateCreator } from 'zustand';
import type { ProjectSummary, ProjectVersion } from '../services/projectsApi';

export interface FeedsSlice {
  feedsProjects: ProjectSummary[];
  feedsQuotaWarning: string | null;
  feedsLoaded: boolean;
  activeServerProjectId: string | null;
  workingStateVersion: number;
  versionList: ProjectVersion[];
  restoredBanner: string | null;
  setFeedsProjects: (projects: ProjectSummary[], warning: string | null) => void;
  upsertFeedProject: (project: ProjectSummary) => void;
  removeFeedProject: (projectId: string) => void;
  setActiveServerProject: (projectId: string | null) => void;
  setWorkingStateVersion: (version: number) => void;
  setVersionList: (versions: ProjectVersion[]) => void;
  setRestoredBanner: (msg: string | null) => void;
}

export const createFeedsSlice: StateCreator<
  FeedsSlice,
  [['zustand/immer', never]],
  [],
  FeedsSlice
> = (set) => ({
  feedsProjects: [],
  feedsQuotaWarning: null,
  feedsLoaded: false,
  activeServerProjectId: null,
  workingStateVersion: 0,
  versionList: [],
  restoredBanner: null,

  setFeedsProjects: (projects, warning) =>
    set((state) => {
      state.feedsProjects = projects;
      state.feedsQuotaWarning = warning;
      state.feedsLoaded = true;
    }),

  upsertFeedProject: (project) =>
    set((state) => {
      const idx = state.feedsProjects.findIndex((p) => p.id === project.id);
      if (idx === -1) state.feedsProjects.unshift(project);
      else state.feedsProjects[idx] = { ...state.feedsProjects[idx], ...project };
    }),

  removeFeedProject: (projectId) =>
    set((state) => {
      state.feedsProjects = state.feedsProjects.filter((p) => p.id !== projectId);
    }),

  setActiveServerProject: (projectId) =>
    set((state) => {
      state.activeServerProjectId = projectId;
      if (projectId === null) {
        state.workingStateVersion = 0;
        state.versionList = [];
      }
    }),

  setWorkingStateVersion: (version) =>
    set((state) => {
      state.workingStateVersion = version;
    }),

  setVersionList: (versions) =>
    set((state) => {
      state.versionList = versions;
    }),

  setRestoredBanner: (msg) =>
    set((state) => {
      state.restoredBanner = msg;
    }),
});
