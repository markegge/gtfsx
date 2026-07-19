// Tests for the "Ask GTFS·X" chat endpoint (issue #68): auth, quota enforcement,
// SSE tool/text event shaping, CLASS-prefix stripping, and telemetry write. The
// outbound Claude API call is mocked by spying globalThis.fetch (same realm as
// the worker under @cloudflare/vitest-pool-workers, as setupEmailCapture does).

import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, dbAll, resetDb, seedUser, env } from './_setup';
import { assistantConfigured } from '../assistant/config';

// A canned Anthropic SSE stream: a "supported" answer (CLASS-prefixed) plus one
// open_panel tool call, with usage on message_start / message_delta.
function cannedSSE(): string {
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 120 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CLASS: supported\n' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Open the Frequencies panel to set headways.' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'open_panel', input: {} } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"target":"frequencies","label":"Open Frequencies"}' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

function mockAnthropic(sse: string): MockInstance {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://api.anthropic.com/')) {
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return original(input as RequestInfo, init);
  });
}

function utcDayKey(userId: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `assistant:quota:${userId}:${y}-${m}-${d}`;
}

async function loginClient(plan: 'free' | 'agency' | 'enterprise' = 'agency') {
  const user = await seedUser({ email: `ask-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, plan });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, userId: user.id };
}

const body = { messages: [{ role: 'user', content: 'How do I set headways?' }], context: {} };

describe('assistant chat', () => {
  let spy: MockInstance;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    spy = mockAnthropic(cannedSSE());
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it('assistantConfigured reflects the presence of the key', () => {
    expect(assistantConfigured({})).toBe(false);
    expect(assistantConfigured({ ANTHROPIC_API_KEY: '' })).toBe(false);
    expect(assistantConfigured({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe(true);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const client = makeClient();
    const res = await client.post('/api/assistant/chat', body);
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('api.anthropic.com'), expect.anything());
  });

  it('streams stripped text, a tool event, and done; writes telemetry', async () => {
    const { client, userId } = await loginClient('agency');
    const res = await client.post('/api/assistant/chat', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');

    const text = await res.text();
    // The CLASS: prefix line is stripped and never forwarded.
    expect(text).not.toContain('CLASS:');
    expect(text).toContain('event: text');
    expect(text).toContain('Open the Frequencies panel to set headways.');
    // The tool_use block is surfaced as a structured `tool` event.
    expect(text).toContain('event: tool');
    expect(text).toContain('"name":"open_panel"');
    expect(text).toContain('"target":"frequencies"');
    // The done event carries the parsed answer class.
    expect(text).toContain('event: done');
    expect(text).toContain('"answerClass":"supported"');

    // Telemetry row.
    const rows = await dbAll<{ answer_class: string; tools_called: string; docs_cited: number; question: string; tokens_in: number; tokens_out: number }>(
      `SELECT answer_class, tools_called, docs_cited, question, tokens_in, tokens_out FROM assistant_messages WHERE user_id = ?`,
      userId,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].answer_class).toBe('supported');
    expect(JSON.parse(rows[0].tools_called)).toEqual(['open_panel']);
    expect(rows[0].docs_cited).toBe(0);
    expect(rows[0].question).toBe('How do I set headways?');
    expect(rows[0].tokens_in).toBe(120);
    expect(rows[0].tokens_out).toBe(42);
  });

  it('consumes daily quota (counter increments on a successful send)', async () => {
    const { client, userId } = await loginClient('free');
    await client.post('/api/assistant/chat', body).then((r) => r.text());
    const used = await env.KV.get(utcDayKey(userId));
    expect(used).toBe('1');
  });

  it('enforces the per-plan daily quota with a structured 429', async () => {
    const { client, userId } = await loginClient('free');
    // Free tier = 10/day. Pin the counter at the limit.
    await env.KV.put(utcDayKey(userId), '10');

    const res = await client.post('/api/assistant/chat', body);
    expect(res.status).toBe(429);
    const payload = (await res.json()) as { error: string; plan: string; limit: number; upgradeTo: string | null };
    expect(payload.error).toBe('quota_exceeded');
    expect(payload.plan).toBe('free');
    expect(payload.limit).toBe(10);
    expect(payload.upgradeTo).toBe('agency');
    // The model was never called when the quota blocks the request.
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('api.anthropic.com'), expect.anything());
    // No telemetry row for a blocked request.
    const rows = await dbAll(`SELECT id FROM assistant_messages WHERE user_id = ?`, userId);
    expect(rows.length).toBe(0);
  });
});
