// Unit tests for the assistant conversation slice (issue #68). Exercises the
// state transitions the AskGtfsxPanel drives during a streamed exchange, plus
// dedup, quota, and new-conversation reset — no network involved.

import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import { createAssistantSlice, type AssistantSlice } from '../assistantSlice';

function makeStore() {
  return createStore<AssistantSlice>()(immer(createAssistantSlice));
}

describe('assistantSlice', () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it('open/close/toggle', () => {
    expect(store.getState().assistantOpen).toBe(false);
    store.getState().openAssistant();
    expect(store.getState().assistantOpen).toBe(true);
    store.getState().toggleAssistant();
    expect(store.getState().assistantOpen).toBe(false);
  });

  it('runs a full streamed exchange', () => {
    const s = store.getState();
    s.addAssistantUserMessage('how do I add shapes?');
    const id = s.startAssistantReply();
    expect(store.getState().assistantStreaming).toBe(true);
    expect(store.getState().assistantMessages).toHaveLength(2);

    store.getState().appendAssistantText(id, 'Use ');
    store.getState().appendAssistantText(id, 'Generate shapes.');
    store.getState().addAssistantDoc(id, { url: '/docs/shapes-from-stops/', title: 'Shapes from stops' });
    store.getState().addAssistantAction(id, { target: 'validation', label: 'Open Validation' });
    store.getState().finishAssistantReply(id, 'supported');

    const reply = store.getState().assistantMessages[1];
    expect(reply.text).toBe('Use Generate shapes.');
    expect(reply.streaming).toBe(false);
    expect(reply.answerClass).toBe('supported');
    expect(reply.docs).toHaveLength(1);
    expect(reply.actions).toHaveLength(1);
    expect(store.getState().assistantStreaming).toBe(false);
  });

  it('dedupes docs and actions', () => {
    const s = store.getState();
    const id = s.startAssistantReply();
    store.getState().addAssistantDoc(id, { url: '/docs/validation/', title: 'Validation' });
    store.getState().addAssistantDoc(id, { url: '/docs/validation/', title: 'Validation' });
    store.getState().addAssistantAction(id, { target: 'validation', label: 'Open Validation' });
    store.getState().addAssistantAction(id, { target: 'validation', label: 'Open Validation' });
    const reply = store.getState().assistantMessages[0];
    expect(reply.docs).toHaveLength(1);
    expect(reply.actions).toHaveLength(1);
  });

  it('tracks the feature-request card through its lifecycle', () => {
    const s = store.getState();
    const id = s.startAssistantReply();
    store.getState().setAssistantFeatureRequest(id, { title: 'Drag-to-reroute', body: 'Let me drag route lines.' });
    expect(store.getState().assistantMessages[0].featureRequest?.status).toBe('draft');
    store.getState().setFeatureRequestStatus(id, 'posting');
    expect(store.getState().assistantMessages[0].featureRequest?.status).toBe('posting');
    store.getState().setFeatureRequestStatus(id, 'posted', { threadUrl: '/community/feature-requests/abc-drag' });
    expect(store.getState().assistantMessages[0].featureRequest?.status).toBe('posted');
    expect(store.getState().assistantMessages[0].featureRequest?.threadUrl).toBe('/community/feature-requests/abc-drag');
  });

  it('records a reply error and stops streaming', () => {
    const s = store.getState();
    const id = s.startAssistantReply();
    store.getState().setAssistantReplyError(id, 'Something went wrong.');
    expect(store.getState().assistantMessages[0].error).toBe('Something went wrong.');
    expect(store.getState().assistantMessages[0].streaming).toBe(false);
    expect(store.getState().assistantStreaming).toBe(false);
  });

  it('new conversation resets messages, streaming, and quota', () => {
    const s = store.getState();
    s.addAssistantUserMessage('hi');
    s.startAssistantReply();
    s.setAssistantQuota({ plan: 'free', limit: 10, used: 10, resetAt: 0, upgradeTo: 'agency' });
    store.getState().newAssistantConversation();
    expect(store.getState().assistantMessages).toHaveLength(0);
    expect(store.getState().assistantStreaming).toBe(false);
    expect(store.getState().assistantQuota).toBeNull();
  });
});
