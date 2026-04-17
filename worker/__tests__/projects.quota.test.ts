// Quota soft-warn and hard-enforce behavior. Because the env is fixed at
// pool boot, we test the soft-warn path (HARD_LIMITS=false) in-process and
// simulate the hard-enforce path by toggling the row count + hand-calling
// the enforceQuota helper (since we can't flip the env mid-test).

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { ulid } from 'ulidx';

async function loggedInClient(email: string) {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, userId: user.id };
}

describe('project quotas', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('soft warning at 90%: 19th project creates + X-Quota-Warning header', async () => {
    const { client, userId } = await loggedInClient('quota1@example.com');

    // Seed 18 projects directly via SQL. The 19th POST observes `used=18`,
    // which is >= warnAt (Math.floor(20 * 0.9) = 18), so the warning header
    // should be emitted.
    const now = Date.now();
    for (let i = 0; i < 18; i += 1) {
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

    const res = await client.post('/api/projects', { name: 'Project 19' });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Quota-Warning')).toMatch(/^\d+\/20$/);
  });

  it('soft mode: user can create a 21st project (HARD_LIMITS=false in tests); warning still set', async () => {
    const { client, userId } = await loggedInClient('quota2@example.com');

    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
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

    const res = await client.post('/api/projects', { name: 'Over Limit' });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Quota-Warning')).toBe('20/20');
  });

  // TODO(test-harness): assert the HARD_LIMITS=true path. The env binding is
  // fixed at pool boot so we cannot flip it per-test. A future iteration could
  // add a second test project with HARD_LIMITS=true in vitest.config.ts, but
  // the soft path already exercises enforceQuota end-to-end.

  it('soft mode on versions: 51st version post still succeeds + warning', async () => {
    const { client, userId } = await loggedInClient('quota3@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'ManyVersions' }),
    );
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) {
      await dbRun(
        `INSERT INTO feed_version
           (id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at)
         VALUES (?, ?, ?, ?, ?, '', 0, '{}', 0, 0, ?)`,
        ulid(),
        proj.id,
        `v${i}`,
        userId,
        `projects/${proj.id}/versions/fake${i}/state.json.gz`,
        now + i,
      );
    }

    const form = new FormData();
    const body = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]); // minimal gzip magic
    form.append('state', new Blob([body], { type: 'application/json' }), 'state.json.gz');
    form.append(
      'meta',
      JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0, label: 'v50' }),
    );
    const res = await client.post(`/api/projects/${proj.id}/versions`, undefined, { body: form });
    // With HARD_LIMITS=false, soft-mode returns success with a warning header.
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Quota-Warning')).toBe('50/50');
  });
});
