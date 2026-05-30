// /api/projects/import — bulk import from local IndexedDB. Happy path, slug
// collision, partial success when over quota.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { ulid } from 'ulidx';

async function loggedInClient(email: string, plan: 'free' | 'pro' | 'agency' | 'enterprise' = 'agency') {
  const user = await seedUser({ email, plan });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, userId: user.id };
}

// Encode a Uint8Array to base64 (atob/btoa-compatible) — reusable helper.
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

describe('/api/projects/import', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('imports two projects from the local payload', async () => {
    const { client } = await loggedInClient('import1@example.com');
    const blob1 = toBase64(await gzip(JSON.stringify({ routes: [1] })));
    const blob2 = toBase64(await gzip(JSON.stringify({ routes: [2] })));

    const res = await client.post('/api/projects/import', {
      projects: [
        { name: 'Local 1', workingState: blob1, workingStateSize: blob1.length },
        { name: 'Local 2', workingState: blob2, workingStateSize: blob2.length },
      ],
    });
    const body = await client.json<{ imported: { slug: string }[]; skipped: unknown[] }>(res);
    expect(body.imported).toHaveLength(2);
    expect(body.skipped).toHaveLength(0);
    expect(body.imported.map((p) => p.slug).sort()).toEqual(['local-1', 'local-2']);
  });

  it('slug collision with an existing server project gets suffixed', async () => {
    const { client } = await loggedInClient('import2@example.com');
    await client.post('/api/projects', { name: 'Shared' }); // slug=shared

    const blob = toBase64(await gzip(JSON.stringify({ routes: [] })));
    const res = await client.post('/api/projects/import', {
      projects: [{ name: 'Shared', workingState: blob, workingStateSize: blob.length }],
    });
    const body = await client.json<{ imported: { slug: string }[] }>(res);
    expect(body.imported).toHaveLength(1);
    // `uniqueSlug()` starts at n=2 on first collision.
    expect(body.imported[0].slug).toBe('shared-2');
  });

  it('partial import when the user is already near their quota', async () => {
    const { client, userId } = await loggedInClient('import3@example.com', 'pro');

    // Pro tier has projects=10. Seed 9 so the user has 1 slot left.
    const now = Date.now();
    for (let i = 0; i < 9; i += 1) {
      await dbRun(
        `INSERT INTO feed_project (id, slug, name, description, owner_type, owner_id,
           working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
           archived_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'user', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
        ulid(),
        `pre-${i}`,
        `Pre ${i}`,
        userId,
        now,
        now,
      );
    }

    const blob = toBase64(await gzip(JSON.stringify({})));
    const res = await client.post('/api/projects/import', {
      projects: [
        { name: 'Fits', workingState: blob, workingStateSize: blob.length },
        { name: 'NoRoom 1', workingState: blob, workingStateSize: blob.length },
        { name: 'NoRoom 2', workingState: blob, workingStateSize: blob.length },
      ],
    });
    const body = await client.json<{
      imported: { name: string }[];
      skipped: { name: string; reason: string }[];
    }>(res);
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0].name).toBe('Fits');
    expect(body.skipped).toHaveLength(2);
    expect(body.skipped.every((s) => s.reason === 'quota_exceeded')).toBe(true);
  });

  it('invalid base64 is skipped with reason=invalid_base64', async () => {
    const { client } = await loggedInClient('import4@example.com');
    const res = await client.post('/api/projects/import', {
      projects: [{ name: 'Bad', workingState: '%%%-not-b64', workingStateSize: 10 }],
    });
    const body = await client.json<{ imported: unknown[]; skipped: { reason: string }[] }>(res);
    expect(body.imported).toHaveLength(0);
    expect(body.skipped[0].reason).toBe('invalid_base64');
  });
});
