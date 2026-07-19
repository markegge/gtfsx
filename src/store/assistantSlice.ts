import type { StateCreator } from 'zustand';
import type {
  AnswerClass,
  AssistantLinkDocs,
  AssistantOpenPanel,
  AssistantFeatureRequestDraft,
} from '../services/assistantApi';

// Per-session conversation state for the "Ask GTFS·X" chat panel (issue #68).
// Pure state + mutators; the panel component owns the network orchestration
// (calls streamAssistantChat and drives these setters) so the slice stays
// testable without a server. "New conversation" resets messages; quota-exhausted
// state is surfaced via `assistantQuota`.

export type FeatureRequestStatus = 'draft' | 'posting' | 'posted' | 'error';

export interface AssistantFeatureRequestCard extends AssistantFeatureRequestDraft {
  status: FeatureRequestStatus;
  threadUrl?: string;
  error?: string;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  answerClass?: AnswerClass;
  docs?: AssistantLinkDocs[];
  actions?: AssistantOpenPanel[];
  featureRequest?: AssistantFeatureRequestCard;
  error?: string;
}

export interface AssistantQuotaInfo {
  plan: string;
  limit: number;
  used: number;
  resetAt: number;
  upgradeTo: string | null;
}

export interface AssistantSlice {
  assistantOpen: boolean;
  assistantMessages: AssistantMessage[];
  assistantStreaming: boolean;
  // Set when the daily quota is exhausted (drives the upgrade card); cleared on
  // a new conversation or a fresh day's successful send.
  assistantQuota: AssistantQuotaInfo | null;

  openAssistant: () => void;
  closeAssistant: () => void;
  toggleAssistant: () => void;
  newAssistantConversation: () => void;

  // Streaming orchestration mutators (called by AskGtfsxPanel):
  addAssistantUserMessage: (text: string) => void;
  startAssistantReply: () => string;
  appendAssistantText: (id: string, text: string) => void;
  addAssistantDoc: (id: string, doc: AssistantLinkDocs) => void;
  addAssistantAction: (id: string, action: AssistantOpenPanel) => void;
  setAssistantFeatureRequest: (id: string, draft: AssistantFeatureRequestDraft) => void;
  setFeatureRequestStatus: (id: string, status: FeatureRequestStatus, extra?: { threadUrl?: string; error?: string }) => void;
  finishAssistantReply: (id: string, answerClass: AnswerClass) => void;
  setAssistantReplyError: (id: string, message: string) => void;
  setAssistantStreaming: (v: boolean) => void;
  setAssistantQuota: (q: AssistantQuotaInfo | null) => void;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

export const createAssistantSlice: StateCreator<
  AssistantSlice,
  [['zustand/immer', never]],
  [],
  AssistantSlice
> = (set) => ({
  assistantOpen: false,
  assistantMessages: [],
  assistantStreaming: false,
  assistantQuota: null,

  openAssistant: () => set((s) => { s.assistantOpen = true; }),
  closeAssistant: () => set((s) => { s.assistantOpen = false; }),
  toggleAssistant: () => set((s) => { s.assistantOpen = !s.assistantOpen; }),
  newAssistantConversation: () => set((s) => {
    s.assistantMessages = [];
    s.assistantStreaming = false;
    s.assistantQuota = null;
  }),

  addAssistantUserMessage: (text) => set((s) => {
    s.assistantMessages.push({ id: newId(), role: 'user', text });
  }),
  startAssistantReply: () => {
    const id = newId();
    set((s) => {
      s.assistantMessages.push({ id, role: 'assistant', text: '', streaming: true, docs: [], actions: [] });
      s.assistantStreaming = true;
    });
    return id;
  },
  appendAssistantText: (id, text) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (m) m.text += text;
  }),
  addAssistantDoc: (id, doc) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (!m) return;
    if (!m.docs) m.docs = [];
    if (!m.docs.some((d) => d.url === doc.url)) m.docs.push(doc);
  }),
  addAssistantAction: (id, action) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (!m) return;
    if (!m.actions) m.actions = [];
    if (!m.actions.some((a) => a.target === action.target && a.label === action.label)) m.actions.push(action);
  }),
  setAssistantFeatureRequest: (id, draft) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (m) m.featureRequest = { ...draft, status: 'draft' };
  }),
  setFeatureRequestStatus: (id, status, extra) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (m && m.featureRequest) {
      m.featureRequest.status = status;
      if (extra?.threadUrl) m.featureRequest.threadUrl = extra.threadUrl;
      if (extra?.error) m.featureRequest.error = extra.error;
    }
  }),
  finishAssistantReply: (id, answerClass) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (m) { m.streaming = false; m.answerClass = answerClass; }
    s.assistantStreaming = false;
  }),
  setAssistantReplyError: (id, message) => set((s) => {
    const m = s.assistantMessages.find((x) => x.id === id);
    if (m) { m.streaming = false; m.error = message; }
    s.assistantStreaming = false;
  }),
  setAssistantStreaming: (v) => set((s) => { s.assistantStreaming = v; }),
  setAssistantQuota: (q) => set((s) => { s.assistantQuota = q; }),
});
