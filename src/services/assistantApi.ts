// Client for the streamed "Ask GTFS·X" chat endpoint. Uses raw fetch + a
// ReadableStream reader (not EventSource — we need POST + credentials + the
// X-GB-Client CSRF header). Parses the worker's SSE events (text/tool/done/error)
// and drives handler callbacks. Non-2xx responses (401/429/503) are JSON, not SSE.

import { DEFAULT_HEADERS } from './apiClient';

export type AnswerClass = 'supported' | 'workaround' | 'not_supported';

export interface AssistantChatContext {
  sidebarSection?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  counts?: {
    routes?: number;
    stops?: number;
    trips?: number;
    calendars?: number;
    flexZones?: number;
  };
}

export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantOpenPanel {
  target: string;
  label: string;
}
export interface AssistantLinkDocs {
  url: string;
  title: string;
}
export interface AssistantFeatureRequestDraft {
  title: string;
  body: string;
}

export interface AssistantError {
  message: string;
  code?: string;
  status?: number;
  // Structured quota info when code === 'quota_exceeded'.
  quota?: { plan: string; limit: number; used: number; resetAt: number; upgradeTo: string | null };
}

export interface AssistantStreamHandlers {
  onText: (text: string) => void;
  onOpenPanel: (p: AssistantOpenPanel) => void;
  onLinkDocs: (d: AssistantLinkDocs) => void;
  onFeatureRequest: (d: AssistantFeatureRequestDraft) => void;
  onDone: (info: { answerClass: AnswerClass; tokensIn: number; tokensOut: number }) => void;
  onError: (err: AssistantError) => void;
}

function parseTool(name: string, input: Record<string, unknown>, h: AssistantStreamHandlers): void {
  if (name === 'open_panel' && typeof input.target === 'string' && typeof input.label === 'string') {
    h.onOpenPanel({ target: input.target, label: input.label });
  } else if (name === 'link_docs' && typeof input.url === 'string' && typeof input.title === 'string') {
    h.onLinkDocs({ url: input.url, title: input.title });
  } else if (name === 'suggest_feature_request' && typeof input.title === 'string' && typeof input.body === 'string') {
    h.onFeatureRequest({ title: input.title, body: input.body });
  }
}

/**
 * POST a conversation and stream the answer. Returns an abort() to cancel.
 * Errors (network, non-2xx, mid-stream error events) are delivered via
 * handlers.onError, never thrown.
 */
export function streamAssistantChat(
  body: { messages: AssistantChatMessage[]; context: AssistantChatContext },
  handlers: AssistantStreamHandlers,
): () => void {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError({ message: (e as Error)?.message ?? 'Network error', code: 'network_error' });
      return;
    }

    if (!res.ok) {
      // Error responses are JSON.
      let payload: Record<string, unknown> = {};
      try {
        payload = (await res.json()) as Record<string, unknown>;
      } catch {
        // ignore
      }
      const code = typeof payload.error === 'string' ? payload.error : 'error';
      const message =
        typeof payload.message === 'string'
          ? payload.message
          : res.status === 503
            ? 'The assistant is unavailable right now.'
            : 'Something went wrong.';
      const err: AssistantError = { message, code, status: res.status };
      if (code === 'quota_exceeded') {
        err.quota = {
          plan: String(payload.plan ?? ''),
          limit: Number(payload.limit ?? 0),
          used: Number(payload.used ?? 0),
          resetAt: Number(payload.resetAt ?? 0),
          upgradeTo: (payload.upgradeTo as string | null) ?? null,
        };
      }
      handlers.onError(err);
      return;
    }

    if (!res.body) {
      handlers.onError({ message: 'No response stream.', code: 'no_body' });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === 'text' && typeof data.text === 'string') {
            handlers.onText(data.text);
          } else if (event === 'tool' && typeof data.name === 'string') {
            parseTool(data.name, (data.input as Record<string, unknown>) ?? {}, handlers);
          } else if (event === 'done') {
            handlers.onDone({
              answerClass: (data.answerClass as AnswerClass) ?? 'supported',
              tokensIn: Number(data.tokensIn ?? 0),
              tokensOut: Number(data.tokensOut ?? 0),
            });
          } else if (event === 'error') {
            handlers.onError({ message: String(data.message ?? 'The assistant hit an error.'), code: 'stream_error' });
          }
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      handlers.onError({ message: (e as Error)?.message ?? 'Stream error', code: 'stream_error' });
    }
  })();

  return () => controller.abort();
}
