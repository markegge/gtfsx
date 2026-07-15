// Quota soft-warn and hard-enforce behavior. Because the env is fixed at
// pool boot, we test the soft-warn path (HARD_LIMITS=false) in-process and
// simulate the hard-enforce path by toggling the row count + hand-calling
// the enforceQuota helper (since we can't flip the env mid-test).

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { ulid } from 'ulidx';

async function loggedInClient(email: string, plan: 'free' | 'agency' | 'enterprise' = 'agency') {
  // Quota tests pin to a plan with a finite project limit so the assertions
  // stay readable. Free = 3 projects — the only finite-project tier now that
  // Agency is unlimited; Agency still has 50 snapshots/project.
  const user = await seedUser({ email, plan });
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

  it('soft warning at 90%: 3rd project creates + X-Quota-Warning header (free tier)', async () => {
    const { client, userId } = await loggedInClient('quota1@example.com', 'free');

    // Free tier has projects=3. warnAt = floor(3 * 0.9) = 2. Seed 2 so the
    // 3rd POST observes used=2 >= warnAt and emits the warning header.
    const now = Date.now();
    for (let i = 0; i < 2; i += 1) {
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

    const res = await client.post('/api/projects', { name: 'Project 3' });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Quota-Warning')).toMatch(/^\d+\/3$/);
  });

  it('hard cap: free user at the 3-feed limit is blocked from creating a 4th (409), even with HARD_LIMITS=false', async () => {
    // The saved-feed cap is a hard wall at feed creation regardless of the
    // global HARD_LIMITS env (enforceQuota(..., { hard: true }) on the projects
    // create path), so a free owner already at 3 feeds cannot create a 4th.
    const { client, userId } = await loggedInClient('quota2@example.com', 'free');

    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
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
    expect(res.status).toBe(409);
    // Read the raw body directly — the client.json() helper throws on non-2xx.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('quota_exceeded');

    // The blocked feed was not created (still 3).
    const rows = await dbAll<{ n: number }>(
      `SELECT COUNT(*) AS n FROM feed_project WHERE owner_id = ? AND deleted_at IS NULL`,
      userId,
    );
    expect(rows[0].n).toBe(3);
  });

  // TODO(test-harness): assert the HARD_LIMITS=true path. The env binding is
  // fixed at pool boot so we cannot flip it per-test. A future iteration could
  // add a second test project with HARD_LIMITS=true in vitest.config.ts, but
  // the soft path already exercises enforceQuota end-to-end.

  it('soft mode on snapshots: 51st snapshot post still succeeds + warning (agency tier)', async () => {
    const { client, userId } = await loggedInClient('quota3@example.com', 'agency');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'ManySnapshots' }),
    );
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) {
      await dbRun(
        `INSERT INTO feed_snapshot
           (id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at)
         VALUES (?, ?, ?, ?, ?, '', 0, '{}', 0, 0, ?)`,
        ulid(),
        proj.id,
        `v${i}`,
        userId,
        `projects/${proj.id}/snapshots/fake${i}/state.json.gz`,
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
    const res = await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: form });
    // With HARD_LIMITS=false, soft-mode returns success with a warning header.
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Quota-Warning')).toBe('50/50');
  });
});
