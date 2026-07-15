// Shared test-harness helpers. File-name is underscore-prefixed so Vitest
// doesn't pick it up as a test file (see `include` in vitest.config.ts).
//
// Includes:
//   - applyMigrations(): runs every pending migration (idempotent).
//   - resetDb(): truncates all app tables between tests for deterministic state.
//   - seedUser(): inserts an already-verified user (bypasses email verify).
//   - setupEmailCapture() + extractToken(): spies on Resend's outbound fetch.

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { vi, expect, type MockInstance } from 'vitest';
import type { Env } from '../env';

// The test-only binding added in vitest.config.ts.
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}
const testEnv = env as unknown as TestEnv;

// ─── Migrations ─────────────────────────────────────────────────────────────

let migrationsApplied = false;
export async function applyMigrations(): Promise<void> {
  if (migrationsApplied) return;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  migrationsApplied = true;
}

// ─── DB reset ───────────────────────────────────────────────────────────────

export async function resetDb(): Promise<void> {
  await applyMigrations();
  // forum_thread.solved_post_id ↔ forum_post is a circular FK — break it before
  // deleting either side. (forum_thread/forum_post FK to user without ON DELETE
  // CASCADE, so they must be cleared before the user delete below.)
  await testEnv.DB.prepare(`UPDATE forum_thread SET solved_post_id = NULL`).run();
  // Child tables first, then parents.
  const tables = [
    'audit_event',
    'auth_token',
    'session',
    'credential',
    'forum_post_upvote',
    'forum_subscription',
    'forum_image',
    'forum_post',
    'forum_thread',
    'forum_user_state',
    'publication_history',
    'publication',
    'project_catalog_submission',
    'project_rt_feed',
    'embed_impression',
    'pro_intent',
    'draft_link',
    'scheduled_publish',
    'feed_snapshot',
    'feed_project',
    'organization_membership',
    'organization',
    'user',
  ];
  for (const t of tables) {
    await testEnv.DB.prepare(`DELETE FROM ${t}`).run();
  }
  // Wipe rate-limit counters (and any other KV state).
  const listed = await testEnv.KV.list();
  for (const k of listed.keys) {
    await testEnv.KV.delete(k.name);
  }
  // Wipe R2 feed blobs left by previous tests.
  const r2listed = await testEnv.FEEDS.list();
  for (const o of r2listed.objects) {
    await testEnv.FEEDS.delete(o.key);
  }
}

// ─── User seeding ───────────────────────────────────────────────────────────

// Mirrors PBKDF2 hashing in worker/util/crypto.ts. We compute the hash
// out-of-band so tests don't need to re-import it.
import { hashPassword } from '../util/crypto';
import { ulid } from 'ulidx';

export interface SeededUser {
  id: string;
  email: string;
  displayName: string;
  password: string;
}

export async function seedUser(opts: {
  email?: string;
  password?: string;
  displayName?: string;
  status?: 'pending_verification' | 'active' | 'disabled' | 'deleted_soft';
  staff?: boolean;
  /**
   * Defaults to `'agency'` so tests exercise paid features (snapshots, publish,
   * embeds, org operations, etc.) without each one having to opt in. Pass
   * `'free'` explicitly when testing paywall enforcement.
   */
  plan?: 'free' | 'agency' | 'enterprise';
} = {}): Promise<SeededUser> {
  const id = ulid();
  const email = opts.email ?? `user-${id.toLowerCase()}@example.com`;
  const password = opts.password ?? 'hunter2-hunter2';
  const displayName = opts.displayName ?? 'Test User';
  const status = opts.status ?? 'active';
  const staff = opts.staff ? 1 : 0;
  const plan = opts.plan ?? 'agency';
  const now = Date.now();

  await testEnv.DB.prepare(
    `INSERT INTO user (id, email, display_name, status, staff, plan, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, email, displayName, status, staff, plan, now, now)
    .run();

  const passwordHash = await hashPassword(password);
  await testEnv.DB.prepare(
    `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
     VALUES (?, ?, 'password', ?, ?, ?)`,
  )
    .bind(ulid(), id, passwordHash, now, now)
    .run();

  return { id, email, displayName, password };
}

// ─── Email capture ──────────────────────────────────────────────────────────

export interface CapturedEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  /** Resend top-level reply_to, when the sender set one. */
  reply_to?: string;
  /** Resend top-level bcc, when the sender set one. */
  bcc?: string;
}

export interface EmailCapture {
  emails: CapturedEmail[];
  /** When set, Resend calls return this response status + body instead of success. */
  failWith?: { status: number; body?: string };
  /** Pull the token param out of the first captured email for a given to address (or overall). */
  tokenFor(to?: string): string | null;
  linkFor(to?: string): string | null;
  simulateSendFailure(status?: number, body?: string): void;
  restore(): void;
}

export function setupEmailCapture(): EmailCapture {
  const emails: CapturedEmail[] = [];
  const self: EmailCapture = {
    emails,
    tokenFor: () => null,
    linkFor: () => null,
    simulateSendFailure(status = 401, body = '{"error":"unauthorized"}') {
      self.failWith = { status, body };
    },
    restore: () => spy.mockRestore(),
  };
  const original = globalThis.fetch;
  const spy: MockInstance = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.resend.com/emails')) {
        if (self.failWith) {
          return new Response(self.failWith.body ?? '', { status: self.failWith.status });
        }
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        try {
          const parsed = JSON.parse(bodyStr) as CapturedEmail;
          emails.push({
            to: String(parsed.to ?? ''),
            from: String(parsed.from ?? ''),
            subject: String(parsed.subject ?? ''),
            html: String(parsed.html ?? ''),
            text: String(parsed.text ?? ''),
            ...(parsed.reply_to != null ? { reply_to: String(parsed.reply_to) } : {}),
            ...(parsed.bcc != null ? { bcc: String(parsed.bcc) } : {}),
          });
        } catch {
          // ignore malformed body
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return original(input as RequestInfo, init);
    },
  );

  self.tokenFor = (to?: string) => {
    const match = to ? emails.find((e) => e.to === to) : emails[emails.length - 1];
    if (!match) return null;
    return extractToken(match.text) ?? extractToken(match.html);
  };
  self.linkFor = (to?: string) => {
    const match = to ? emails.find((e) => e.to === to) : emails[emails.length - 1];
    if (!match) return null;
    return extractLink(match.text) ?? extractLink(match.html);
  };
  return self;
}

export function extractToken(s: string): string | null {
  const m = s.match(/[?&]token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function extractLink(s: string): string | null {
  const m = s.match(/https?:\/\/[^\s"<]+\?token=[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

export async function dbGet<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
  return testEnv.DB.prepare(sql).bind(...binds).first<T>();
}

export async function dbRun(sql: string, ...binds: unknown[]): Promise<void> {
  await testEnv.DB.prepare(sql).bind(...binds).run();
}

export async function dbAll<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await testEnv.DB.prepare(sql).bind(...binds).all<T>();
  return res.results ?? [];
}

// Re-export env for tests that need direct binding access.
export { testEnv as env };

// Helper: gzip a string via the built-in CompressionStream.
export async function gzip(input: string | Uint8Array): Promise<Uint8Array> {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(buf);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function ungzip(input: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<string> {
  let stream: ReadableStream<Uint8Array>;
  if (input instanceof ReadableStream) {
    stream = input;
  } else {
    const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    stream = new Response(buf).body!;
  }
  const decompressed = stream.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(decompressed).text();
}

// Avoid "unused" complaints for vitest's expect re-export.
export { expect };
