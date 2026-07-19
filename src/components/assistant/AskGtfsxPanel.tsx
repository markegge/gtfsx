import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Markdown } from '../community/Markdown';
import { Button } from '../ui/Button';
import { threadPath } from '../community/permalinks';
import { createThread } from '../../services/forumApi';
import { planDisplayName } from '../billing/planConfig';
import {
  streamAssistantChat,
  type AssistantChatContext,
  type AssistantStreamHandlers,
} from '../../services/assistantApi';
import { isSidebarSection, isBottomPanelTab } from '../../assistant/deepLinkTargets';
import type { AssistantMessage, AssistantFeatureRequestCard } from '../../store/assistantSlice';

const SUGGESTIONS = [
  'How do I add shapes to a feed that has none?',
  'How do I make a circulator route with continuous pickup and drop-off?',
  'Why is my feed failing validation?',
  'How do I publish my feed to a stable URL?',
];

export function AskGtfsxPanel() {
  const open = useStore((s) => s.assistantOpen);
  const messages = useStore((s) => s.assistantMessages);
  const streaming = useStore((s) => s.assistantStreaming);
  const quota = useStore((s) => s.assistantQuota);

  const closeAssistant = useStore((s) => s.closeAssistant);
  const newConversation = useStore((s) => s.newAssistantConversation);

  const setSidebarSection = useStore((s) => s.setSidebarSection);
  const setBottomPanelTab = useStore((s) => s.setBottomPanelTab);
  const setBottomPanelOpen = useStore((s) => s.setBottomPanelOpen);

  const [input, setInput] = useState('');
  const cancelRef = useRef<null | (() => void)>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => { cancelRef.current?.(); }, []);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      const state = useStore.getState();
      if (!text || state.assistantStreaming) return;

      // Build the conversation payload from prior *completed* turns, then add
      // the new user turn. History is text-only — tool calls are one-shot UI
      // side-effects and are never replayed.
      const history = state.assistantMessages
        .filter((m) => m.text && !m.error)
        .map((m) => ({ role: m.role, content: m.text }));

      state.addAssistantUserMessage(text);
      const replyId = state.startAssistantReply();

      const context: AssistantChatContext = {
        sidebarSection: state.sidebarSection ?? null,
        projectId: state.projectId ?? null,
        projectName: state.projectName ?? null,
        counts: {
          routes: state.routes.length,
          stops: state.stops.length,
          trips: state.trips.length,
          calendars: state.calendars.length,
          flexZones: state.flexZones.length,
        },
      };

      const handlers: AssistantStreamHandlers = {
        onText: (t) => useStore.getState().appendAssistantText(replyId, t),
        onOpenPanel: (p) => {
          if (isSidebarSection(p.target) || isBottomPanelTab(p.target)) {
            useStore.getState().addAssistantAction(replyId, p);
          }
        },
        onLinkDocs: (d) => useStore.getState().addAssistantDoc(replyId, d),
        onFeatureRequest: (d) => useStore.getState().setAssistantFeatureRequest(replyId, d),
        onDone: (info) => useStore.getState().finishAssistantReply(replyId, info.answerClass),
        onError: (err) => {
          const st = useStore.getState();
          if (err.code === 'quota_exceeded' && err.quota) st.setAssistantQuota(err.quota);
          st.setAssistantReplyError(replyId, err.message);
        },
      };

      cancelRef.current = streamAssistantChat({ messages: [...history, { role: 'user', content: text }], context }, handlers);
    },
    [],
  );

  const handleAction = useCallback(
    (target: string) => {
      if (isSidebarSection(target)) {
        setSidebarSection(target);
      } else if (isBottomPanelTab(target)) {
        setBottomPanelTab(target);
        setBottomPanelOpen(true);
      }
    },
    [setSidebarSection, setBottomPanelTab, setBottomPanelOpen],
  );

  const confirmFeatureRequest = useCallback(async (messageId: string, fr: AssistantFeatureRequestCard) => {
    const st = useStore.getState();
    st.setFeatureRequestStatus(messageId, 'posting');
    try {
      const { thread } = await createThread({ categoryId: 'feature-requests', title: fr.title, bodyMd: fr.body });
      useStore.getState().setFeatureRequestStatus(messageId, 'posted', { threadUrl: threadPath(thread) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not post the request.';
      useStore.getState().setFeatureRequestStatus(messageId, 'error', { error: msg });
    }
  }, []);

  if (!open) return null;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
    setInput('');
  };

  return (
    <div
      className="absolute bottom-20 left-3 z-40 flex flex-col w-[min(384px,calc(100vw-1.5rem))] max-h-[min(70vh,560px)] bg-white rounded-2xl shadow-2xl border border-sand overflow-hidden"
      role="dialog"
      aria-label="Ask GTFS·X help assistant"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-sand bg-cream/60">
        <span className="text-coral font-heading font-bold text-sm tracking-wide">Ask GTFS·X</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-warm-gray bg-sand/70 rounded px-1.5 py-0.5">beta</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => newConversation()}
          className="text-xs text-warm-gray hover:text-coral transition-colors"
          title="Start a new conversation"
        >
          New
        </button>
        <button
          type="button"
          onClick={() => closeAssistant()}
          aria-label="Close"
          className="w-6 h-6 flex items-center justify-center rounded-md text-warm-gray hover:text-coral hover:bg-white transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="text-sm text-warm-gray space-y-3">
            <p className="text-dark-brown">
              Ask how to do something with your feed — I answer with real click-paths, cite the docs, and I'm honest when something isn't possible.
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q)}
                  className="text-left text-xs text-brown bg-cream hover:bg-sand/60 border border-sand rounded-lg px-3 py-2 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} onAction={handleAction} onConfirmFeatureRequest={confirmFeatureRequest} />
        ))}
      </div>

      {/* Quota-exhausted upgrade card */}
      {quota && (
        <div className="mx-3 mb-2 rounded-lg border border-coral/40 bg-coral-light/40 px-3 py-2 text-xs text-dark-brown">
          <p className="font-semibold">Daily limit reached</p>
          <p className="mt-0.5 text-warm-gray">
            You've used all {quota.limit} messages today on the {planDisplayName(quota.plan as 'free' | 'agency' | 'enterprise')} plan.
            {quota.upgradeTo ? (
              <>
                {' '}
                <a href="/pricing" target="_blank" rel="noopener noreferrer" className="text-coral underline">
                  Upgrade to {planDisplayName(quota.upgradeTo as 'free' | 'agency' | 'enterprise')}
                </a>{' '}
                for a higher limit, or come back tomorrow.
              </>
            ) : (
              ' Your limit resets tomorrow.'
            )}
          </p>
        </div>
      )}

      {/* Input */}
      <form onSubmit={onSubmit} className="border-t border-sand p-2.5 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            }
          }}
          rows={1}
          placeholder="Ask a question…"
          disabled={streaming}
          className="flex-1 resize-none max-h-28 text-sm rounded-lg border border-sand bg-white px-3 py-2 outline-none focus:border-coral disabled:opacity-60"
        />
        <Button type="submit" variant="primary" disabled={streaming || !input.trim()}>
          {streaming ? '…' : 'Send'}
        </Button>
      </form>
    </div>
  );
}

const CLASS_LABEL: Record<string, { text: string; cls: string }> = {
  workaround: { text: 'Workaround', cls: 'bg-gold-light text-amber-700' },
  not_supported: { text: 'Not supported', cls: 'bg-sand text-warm-gray' },
};

function MessageBubble({
  m,
  onAction,
  onConfirmFeatureRequest,
}: {
  m: AssistantMessage;
  onAction: (target: string) => void;
  onConfirmFeatureRequest: (messageId: string, fr: AssistantFeatureRequestCard) => void;
}) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-coral text-white text-sm rounded-2xl rounded-br-sm px-3 py-2 whitespace-pre-wrap">
          {m.text}
        </div>
      </div>
    );
  }

  const label = m.answerClass ? CLASS_LABEL[m.answerClass] : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="max-w-[92%] text-sm text-dark-brown">
        {label && (
          <span className={`inline-block mb-1 text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 ${label.cls}`}>
            {label.text}
          </span>
        )}
        {m.text ? <Markdown className="text-sm">{m.text}</Markdown> : m.streaming ? <TypingDots /> : null}
        {m.error && <p className="text-xs text-red-500 mt-1">{m.error}</p>}
      </div>

      {/* Docs chips */}
      {m.docs && m.docs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {m.docs.map((d) => (
            <a
              key={d.url}
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-teal bg-teal-light/60 hover:bg-teal-light border border-teal/20 rounded-full px-2.5 py-1 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
              {d.title}
            </a>
          ))}
        </div>
      )}

      {/* Deep-link action buttons */}
      {m.actions && m.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {m.actions.map((a) => (
            <Button key={`${a.target}:${a.label}`} variant="secondary" onClick={() => onAction(a.target)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}

      {/* Feature-request card */}
      {m.featureRequest && (
        <FeatureRequestCard messageId={m.id} fr={m.featureRequest} onConfirm={onConfirmFeatureRequest} />
      )}
    </div>
  );
}

function FeatureRequestCard({
  messageId,
  fr,
  onConfirm,
}: {
  messageId: string;
  fr: AssistantFeatureRequestCard;
  onConfirm: (messageId: string, fr: AssistantFeatureRequestCard) => void;
}) {
  return (
    <div className="rounded-xl border border-purple/30 bg-purple-light/40 p-3 text-xs">
      <p className="font-bold text-purple mb-1">💡 File this as a feature request?</p>
      <p className="font-semibold text-dark-brown">{fr.title}</p>
      <p className="text-warm-gray mt-1 whitespace-pre-wrap">{fr.body}</p>
      {fr.status === 'posted' && fr.threadUrl ? (
        <p className="mt-2 text-teal">
          Posted —{' '}
          <a href={fr.threadUrl} target="_blank" rel="noopener noreferrer" className="underline">
            view the thread
          </a>
          .
        </p>
      ) : fr.status === 'error' ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-red-500">{fr.error ?? 'Could not post.'}</span>
          <Button variant="secondary" onClick={() => onConfirm(messageId, fr)}>Retry</Button>
        </div>
      ) : (
        <div className="mt-2">
          <Button
            variant="primary"
            disabled={fr.status === 'posting'}
            onClick={() => onConfirm(messageId, fr)}
          >
            {fr.status === 'posting' ? 'Posting…' : 'Post to community'}
          </Button>
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1 items-center py-1" aria-label="Assistant is typing">
      <span className="w-1.5 h-1.5 rounded-full bg-warm-gray/60 animate-bounce [animation-delay:-0.2s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-warm-gray/60 animate-bounce [animation-delay:-0.1s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-warm-gray/60 animate-bounce" />
    </span>
  );
}
