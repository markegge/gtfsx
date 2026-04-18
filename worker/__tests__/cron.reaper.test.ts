// worker/cron/tasks.ts → reapDeletedUsers(): hard-purges users whose
// soft-delete is older than DELETE_GRACE_MS (30 days). Users still inside
// the grace window are left alone.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import {
  applyMigrations,
  env,
  resetDb,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { reapDeletedUsers, summarizeWeeklyMetrics, DELETE_GRACE_MS } from '../cron/tasks';
import { hashPassword } from '../util/crypto';

async function seedSoftDeletedUser(opts: {
  email: string;
  deletedAt: number;
  withProject?: boolean;
  withR2?: boolean;
  withAuditAsActor?: boolean;
}): Promise<{ userId: string; projectId?: string }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'deleted_soft', 0, ?, ?, ?)`,
  )
    .bind(id, opts.email, 'Reap Me', now, now, opts.deletedAt)
    .run();

  // Add a credential so we can assert cascade deletion.
  const hash = await hashPassword('hunter2-hunter2');
  await env.DB.prepare(
    `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
     VALUES (?, ?, 'password', ?, ?, ?)`,
  )
    .bind(ulid(), id, hash, now, now)
    .run();

  let projectId: string | undefined;
  if (opts.withProject) {
    projectId = ulid();
    await env.DB.prepare(
      `INSERT INTO feed_project
         (id, slug, name, description, owner_type, owner_id,
          working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'user', ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(projectId, `reap-${projectId}`, 'Reap Project', id, `projects/${projectId}/working-state.json.gz`, now, now)
      .run();
    if (opts.withR2) {
      await env.FEEDS.put(`projects/${projectId}/working-state.json.gz`, new TextEncoder().encode('{}'), {
        httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      });
    }
  }

  if (opts.withAuditAsActor) {
    await env.DB.prepare(
      `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, created_at)
       VALUES (?, ?, 'user', ?, 'user.signup', ?)`,
    )
      .bind(ulid(), id, id, now)
      .run();
  }

  return { userId: id, projectId };
}

describe('reapDeletedUsers', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('hard-purges a user whose deleted_at is past the grace period', async () => {
    const deletedAt = Date.now() - DELETE_GRACE_MS - 10 * 24 * 60 * 60 * 1000; // 40 days ago
    const { userId, projectId } = await seedSoftDeletedUser({
      email: 'old-deleted@example.com',
      deletedAt,
      withProject: true,
      withR2: true,
      withAuditAsActor: true,
    });

    // Sanity before.
    const r2Before = await env.FEEDS.get(`projects/${projectId}/working-state.json.gz`);
    expect(r2Before).not.toBeNull();

    const summary = await reapDeletedUsers(env);
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect(summary.reaped).toBeGreaterThanOrEqual(1);

    // User, projects, credentials and actor-audit rows all gone.
    const userRow = await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first();
    expect(userRow).toBeNull();

    const projRow = await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`)
      .bind(projectId)
      .first();
    expect(projRow).toBeNull();

    const credRow = await env.DB.prepare(`SELECT id FROM credential WHERE user_id = ?`)
      .bind(userId)
      .first();
    expect(credRow).toBeNull();

    const auditRow = await env.DB.prepare(
      `SELECT id FROM audit_event WHERE actor_user_id = ?`,
    )
      .bind(userId)
      .first();
    expect(auditRow).toBeNull();

    // R2 blobs cleaned up.
    const r2After = await env.FEEDS.get(`projects/${projectId}/working-state.json.gz`);
    expect(r2After).toBeNull();
  });

  it('leaves users within the 30-day grace window alone', async () => {
    const recent = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const { userId, projectId } = await seedSoftDeletedUser({
      email: 'recent-deleted@example.com',
      deletedAt: recent,
      withProject: true,
      withR2: true,
    });

    const summary = await reapDeletedUsers(env);
    expect(summary.reaped).toBe(0);

    // User row still present.
    const userRow = await env.DB.prepare(`SELECT id FROM user WHERE id = ?`).bind(userId).first();
    expect(userRow).not.toBeNull();

    // Project + blob untouched.
    const projRow = await env.DB.prepare(`SELECT id FROM feed_project WHERE id = ?`)
      .bind(projectId)
      .first();
    expect(projRow).not.toBeNull();

    const r2After = await env.FEEDS.get(`projects/${projectId}/working-state.json.gz`);
    expect(r2After).not.toBeNull();
  });

  it('keeps audit events where the reaped user is the SUBJECT (but not actor)', async () => {
    const deletedAt = Date.now() - DELETE_GRACE_MS - 1000;
    const { userId } = await seedSoftDeletedUser({
      email: 'subject-audit@example.com',
      deletedAt,
    });

    // Insert a subject-only audit row (some admin or other user acted on this account).
    const otherActor = ulid();
    await env.DB.prepare(
      `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, created_at)
       VALUES (?, ?, 'user', ?, 'admin.disable_user', ?)`,
    )
      .bind(ulid(), otherActor, userId, Date.now())
      .run();

    await reapDeletedUsers(env);

    const preserved = await env.DB.prepare(
      `SELECT id FROM audit_event WHERE subject_type = 'user' AND subject_id = ? AND action = 'admin.disable_user'`,
    )
      .bind(userId)
      .first();
    expect(preserved).not.toBeNull();
  });
});

describe('summarizeWeeklyMetrics', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('writes a cached metrics snapshot to KV', async () => {
    // Seed a couple of users for counters.
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await env.DB.prepare(
        `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
         VALUES (?, ?, 'x', 'active', 0, ?, ?)`,
      )
        .bind(ulid(), `metrics-${i}@example.com`, now, now)
        .run();
    }

    const metrics = await summarizeWeeklyMetrics(env);
    expect(metrics.users).toBe(3);
    expect(metrics.computedAt).toBeGreaterThan(0);

    const cached = await env.KV.get('metrics:weekly');
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!) as { users: number };
    expect(parsed.users).toBe(3);
  });
});
