import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext } from '../env';
import { requireAuth } from '../auth/middleware';
import { requireOwnerFeature } from '../billing/middleware';
import { ApiError, validationFailed } from '../util/errors';
import {
  ASSISTANT_MODEL,
  ASSISTANT_MAX_TOKENS,
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  MAX_CONVERSATION_TURNS,
  MAX_MESSAGE_CHARS,
  assistantConfigured,
} from './config';
import { ASSISTANT_TOOLS } from './tools';
import { buildSystemPrompt, buildContextNote, type AssistantCorpus } from './systemPrompt';
import { readQuota, consumeQuota } from './quota';
import corpusJson from './corpus.generated.json';

const corpus = corpusJson as unknown as AssistantCorpus;

// Build the big cacheable system block ONCE at module load — it's static for a
// given corpus, and identical bytes across requests is what makes Claude prompt
// caching hit (see docs/REQUIREMENTS.md + issue #68 cost estimate).
const CACHED_SYSTEM = buildSystemPrompt(corpus);

export const assistantRouter = new Hono<AppContext>();

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_MESSAGE_CHARS),
});

const contextSchema = z
  .object({
    sidebarSection: z.string().max(64).nullish(),
    projectId: z.string().max(64).nullish(),
    projectName: z.string().max(200).nullish(),
    counts: z
      .object({
        routes: z.number().int().nonnegative().max(1_000_000).optional(),
        stops: z.number().int().nonnegative().max(10_000_000).optional(),
        trips: z.number().int().nonnegative().max(10_000_000).optional(),
        calendars: z.number().int().nonnegative().max(1_000_000).optional(),
        flexZones: z.number().int().nonnegative().max(1_000_000).optional(),
      })
      .optional(),
  })
  .optional();

const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_CONVERSATION_TURNS),
  context: contextSchema,
});

async function parseJson<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

function upgradeTargetFor(plan: 'free' | 'agency' | 'enterprise'): 'agency' | 'enterprise' | null {
  if (plan === 'free') return 'agency';
  if (plan === 'agency') return 'enterprise';
  return null;
}

// Small SSE parser for Anthropic's event stream. Yields {event, data} objects.
async function* parseAnthropicSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Events are separated by a blank line.
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
      try {
        yield { event, data: JSON.parse(dataLines.join('\n')) };
      } catch {
        // ignore malformed SSE payloads
      }
    }
  }
}

// POST /api/assistant/chat — streamed help answer.
assistantRouter.post('/chat', requireAuth, async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, chatSchema);

  // Available to all logged-in tiers; presence gate (all plans) + per-plan
  // daily quota below. requireOwnerFeature enforces the FeatureKey against the
  // user's personal plan (and lets staff bypass), keeping parity with every
  // other gated feature even though 'assistant' is granted to every tier.
  await requireOwnerFeature(c.env, 'user', user.id, 'assistant');

  if (!assistantConfigured(c.env)) {
    throw new ApiError(503, 'internal', 'The assistant is not configured right now.', {
      reason: 'assistant_not_configured',
    });
  }

  // Per-plan daily quota.
  const quota = await readQuota(c.env, user.id, user.plan);
  if (quota.remaining <= 0) {
    throw new ApiError(429, 'quota_exceeded', "You've reached today's message limit for Ask GTFS·X.", {
      plan: user.plan,
      limit: quota.limit,
      used: quota.used,
      resetAt: quota.resetAt,
      upgradeTo: upgradeTargetFor(user.plan),
    });
  }
  await consumeQuota(c.env, user.id);

  const contextNote = buildContextNote({
    plan: user.plan,
    sidebarSection: body.context?.sidebarSection ?? null,
    projectName: body.context?.projectName ?? null,
    counts: body.context?.counts,
  });

  const lastUserMsg = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const projectId = body.context?.projectId ?? null;

  const anthropicBody = {
    model: ASSISTANT_MODEL,
    max_tokens: ASSISTANT_MAX_TOKENS,
    stream: true,
    // Help answers don't need extended thinking; disabling keeps latency + cost
    // down and avoids empty thinking blocks in the stream. (Accepted on Sonnet 5.)
    thinking: { type: 'disabled' },
    system: [
      { type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contextNote },
    ],
    tools: ASSISTANT_TOOLS,
    messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
  };

  return streamSSE(c, async (stream) => {
    const toolsCalled: string[] = [];
    let docsCited = 0;
    let answerClass = 'supported';
    let tokensIn = 0;
    let tokensOut = 0;

    // CLASS-prefix stripping state (the model prefixes its answer with
    // `CLASS: <class>\n`; we parse it for telemetry and never forward it).
    let sawFirstNewline = false;
    let pending = '';

    async function handleTextDelta(text: string): Promise<void> {
      if (sawFirstNewline) {
        await stream.writeSSE({ event: 'text', data: JSON.stringify({ text }) });
        return;
      }
      pending += text;
      const nl = pending.indexOf('\n');
      if (nl === -1) return; // still buffering the first line
      const firstLine = pending.slice(0, nl);
      const rest = pending.slice(nl + 1);
      const m = /^\s*CLASS:\s*(supported|workaround|not_supported)\s*$/i.exec(firstLine);
      if (m) {
        answerClass = m[1].toLowerCase();
      } else {
        // Model didn't emit a class line — treat the first line as real content.
        await stream.writeSSE({ event: 'text', data: JSON.stringify({ text: firstLine + '\n' }) });
      }
      sawFirstNewline = true;
      pending = '';
      if (rest) await stream.writeSSE({ event: 'text', data: JSON.stringify({ text: rest }) });
    }

    try {
      const resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': c.env.ANTHROPIC_API_KEY!,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicBody),
      });

      if (!resp.ok || !resp.body) {
        const detail = await resp.text().catch(() => '');
        console.error(`[assistant] upstream ${resp.status}: ${detail.slice(0, 300)}`);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: 'The assistant is temporarily unavailable. Please try again.' }),
        });
        return;
      }

      // Track the in-flight tool_use block (accumulate its streamed JSON input).
      let toolName: string | null = null;
      let toolJson = '';

      for await (const { event, data } of parseAnthropicSSE(resp.body)) {
        const d = data as Record<string, unknown>;
        if (event === 'message_start') {
          const usage = (d.message as { usage?: { input_tokens?: number } })?.usage;
          tokensIn = usage?.input_tokens ?? 0;
        } else if (event === 'content_block_start') {
          const block = d.content_block as { type?: string; name?: string } | undefined;
          if (block?.type === 'tool_use') {
            toolName = block.name ?? null;
            toolJson = '';
          }
        } else if (event === 'content_block_delta') {
          const delta = d.delta as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            await handleTextDelta(delta.text);
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            toolJson += delta.partial_json;
          }
        } else if (event === 'content_block_stop') {
          if (toolName) {
            let input: unknown = {};
            try {
              input = toolJson ? JSON.parse(toolJson) : {};
            } catch {
              input = {};
            }
            toolsCalled.push(toolName);
            if (toolName === 'link_docs') docsCited += 1;
            await stream.writeSSE({ event: 'tool', data: JSON.stringify({ name: toolName, input }) });
            toolName = null;
            toolJson = '';
          }
        } else if (event === 'message_delta') {
          const usage = d.usage as { output_tokens?: number } | undefined;
          if (usage?.output_tokens) tokensOut = usage.output_tokens;
        } else if (event === 'error') {
          const err = d.error as { message?: string } | undefined;
          console.error(`[assistant] stream error: ${err?.message ?? 'unknown'}`);
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: 'The assistant hit an error mid-answer. Please try again.' }),
          });
        }
      }

      // Flush any buffered first-line content that never got a newline.
      if (!sawFirstNewline && pending) {
        const m = /^\s*CLASS:\s*(supported|workaround|not_supported)\s*$/i.exec(pending);
        if (m) answerClass = m[1].toLowerCase();
        else await stream.writeSSE({ event: 'text', data: JSON.stringify({ text: pending }) });
      }

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ answerClass, tokensIn, tokensOut }),
      });
    } catch (err) {
      console.error(`[assistant] fatal: ${(err as Error)?.message ?? err}`);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: 'The assistant is temporarily unavailable. Please try again.' }),
      });
    } finally {
      // Telemetry: one row per exchange (demand signal + docs-gap signal).
      try {
        await c.env.DB.prepare(
          `INSERT INTO assistant_messages
             (id, user_id, project_id, question, answer_class, tools_called, docs_cited, tokens_in, tokens_out, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            ulid(),
            user.id,
            projectId,
            lastUserMsg.slice(0, MAX_MESSAGE_CHARS),
            answerClass,
            JSON.stringify(toolsCalled),
            docsCited,
            tokensIn,
            tokensOut,
            Date.now(),
          )
          .run();
      } catch (err) {
        console.error(`[assistant] telemetry write failed: ${(err as Error)?.message ?? err}`);
      }
    }
  });
});
