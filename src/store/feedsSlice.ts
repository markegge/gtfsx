import type { StateCreator } from 'zustand';
import type { ProjectSummary, ProjectSnapshot } from '../services/projectsApi';

export interface PublicationEntry {
  id: string;
  snapshotId: string | null;
  action: string;
  actorUserId: string | null;
  createdAt: number;
}

export interface PublicationCurrent {
  snapshotId: string;
  publishedAt: number;
  canonicalUrl?: string;
}

export interface DraftLinkEntry {
  tokenHash: string;
  snapshotId: string;
  expiresAt: number;
  createdAt: number;
}

export interface FeedsSlice {
  feedsProjects: ProjectSummary[];
  feedsQuotaWarning: string | null;
  feedsLoaded: boolean;
  activeServerProjectId: string | null;
  workingStateVersion: number;
  snapshotList: ProjectSnapshot[];
  restoredBanner: string | null;
  publicationHistory: PublicationEntry[];
  currentPublication: PublicationCurrent | null;
  draftLinks: DraftLinkEntry[];
  setFeedsProjects: (projects: ProjectSummary[], warning: string | null) => void;
  upsertFeedProject: (project: ProjectSummary) => void;
  removeFeedProject: (projectId: string) => void;
  setActiveServerProject: (projectId: string | null) => void;
  setWorkingStateVersion: (version: number) => void;
  setSnapshotList: (snapshots: ProjectSnapshot[]) => void;
  setRestoredBanner: (msg: string | null) => void;
  setPublicationHistory: (history: PublicationEntry[]) => void;
  setCurrentPublication: (current: PublicationCurrent | null) => void;
  setDraftLinks: (links: DraftLinkEntry[]) => void;
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
  snapshotList: [],
  restoredBanner: null,
  publicationHistory: [],
  currentPublication: null,
  draftLinks: [],

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
        state.snapshotList = [];
        state.publicationHistory = [];
        state.currentPublication = null;
        state.draftLinks = [];
      }
    }),

  setWorkingStateVersion: (version) =>
    set((state) => {
      state.workingStateVersion = version;
    }),

  setSnapshotList: (snapshots) =>
    set((state) => {
      state.snapshotList = snapshots;
    }),

  setRestoredBanner: (msg) =>
    set((state) => {
      state.restoredBanner = msg;
    }),

  setPublicationHistory: (history) =>
    set((state) => {
      state.publicationHistory = history;
    }),

  setCurrentPublication: (current) =>
    set((state) => {
      state.currentPublication = current;
    }),

  setDraftLinks: (links) =>
    set((state) => {
      state.draftLinks = links;
    }),
});
