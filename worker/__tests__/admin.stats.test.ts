// /api/admin/stats — counters reflect DB state; signups bucket correctly;
// KV cache returns identical result within TTL.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  env as testEnv,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function staffClient(email = 'admin@example.com') {
  const user = await seedUser({ email, staff: true });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, user };
}

interface Stats {
  users: { total: number; active: number; pending_verification: number; disabled: number; deleted_soft: number };
  usersByPlan: { free: number; pro: number; agency: number; enterprise: number };
  organizations: { total: number };
  projects: { total: number; byOwnerType: { user: number; org: number } };
  snapshots: { total: number };
  publications: { total: number };
  signups: { last7d: number; last30d: number; allTime: number };
  activeUsers: { last24h: number; last7d: number; last30d: number };
  trend: {
    newUsersByWeek: { week: string; count: number }[];
    newProjectsByWeek: { week: string; count: number }[];
  };
}

describe('/api/admin/stats', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('returns zeroed counters with just the staff user present', async () => {
    const { client } = await staffClient();
    const res = await client.get('/api/admin/stats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Stats;
    expect(body.users.total).toBe(1);
    expect(body.users.active).toBe(1);
    expect(body.organizations.total).toBe(0);
    expect(body.projects.total).toBe(0);
    expect(body.projects.byOwnerType.user).toBe(0);
    expect(body.projects.byOwnerType.org).toBe(0);
    expect(body.snapshots.total).toBe(0);
    expect(body.publications.total).toBe(0);
    expect(body.usersByPlan.agency).toBe(1); // staff user (seedUser defaults to 'agency')
    expect(body.usersByPlan.free).toBe(0);
    expect(body.trend.newUsersByWeek.length).toBe(8);
    expect(body.trend.newProjectsByWeek.length).toBe(8);
  });

  it('signup 7d and 30d buckets reflect real user created_at timestamps', async () => {
    const { client } = await staffClient();

    const now = Date.now();
    const d3 = now - 3 * 24 * 60 * 60 * 1000;
    const d20 = now - 20 * 24 * 60 * 60 * 1000;
    const d60 = now - 60 * 24 * 60 * 60 * 1000;

    // Insert 3 users by hand with controlled created_at.
    for (const ts of [d3, d20, d60]) {
      await dbRun(
        `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
         VALUES (?, ?, 'X', 'active', 0, ?, ?)`,
        ulid(), `s-${ts}@example.com`, ts, ts,
      );
    }

    const res = await client.get('/api/admin/stats');
    const body = (await res.json()) as Stats;

    // All-time: 4 (staff + 3 inserted)
    expect(body.signups.allTime).toBe(4);
    // Last 30d: staff (created now) + d3 + d20 = 3
    expect(body.signups.last30d).toBe(3);
    // Last 7d: staff + d3 = 2
    expect(body.signups.last7d).toBe(2);
  });

  it('counts users broken down by status', async () => {
    const { client } = await staffClient();
    await seedUser({ email: 'pending@example.com', status: 'pending_verification' });
    await seedUser({ email: 'disabled@example.com', status: 'disabled' });
    await seedUser({ email: 'deleted@example.com', status: 'deleted_soft' });

    const res = await client.get('/api/admin/stats');
    const body = (await res.json()) as Stats;
    expect(body.users.total).toBe(4);
    expect(body.users.active).toBe(1); // the staff user
    expect(body.users.pending_verification).toBe(1);
    expect(body.users.disabled).toBe(1);
    expect(body.users.deleted_soft).toBe(1);
  });

  it('counts users by subscription tier, excluding deleted', async () => {
    const { client } = await staffClient(); // staff user is on 'agency' (seedUser default)
    const mk = (email: string, plan: string, status = 'active') =>
      dbRun(
        `INSERT INTO user (id, email, display_name, status, staff, plan, created_at, updated_at)
         VALUES (?, ?, 'X', ?, 0, ?, ?, ?)`,
        ulid(), email, status, plan, Date.now(), Date.now(),
      );
    await mk('free@example.com', 'free');
    await mk('pro@example.com', 'pro');
    await mk('agency@example.com', 'agency');
    await mk('ent@example.com', 'enterprise');
    await mk('gone@example.com', 'pro', 'deleted_soft'); // excluded from the breakdown

    const res = await client.get('/api/admin/stats');
    const body = (await res.json()) as Stats;
    expect(body.usersByPlan.free).toBe(1);
    expect(body.usersByPlan.pro).toBe(1); // deleted pro not counted
    expect(body.usersByPlan.agency).toBe(2); // agency@ + the staff user
    expect(body.usersByPlan.enterprise).toBe(1);
  });

  it('counts orgs, projects, snapshots, publications', async () => {
    const { client, user: staff } = await staffClient();

    // Seed an org, a user-owned project, an org-owned project, a version, a publication.
    const now = Date.now();
    const orgId = ulid();
    await dbRun(
      `INSERT INTO organization (id, slug, name, created_at) VALUES (?, 'o1', 'Org One', ?)`,
      orgId, now,
    );
    const pU = ulid();
    await dbRun(
      `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, created_at, updated_at)
       VALUES (?, 'p1', 'P1', 'user', ?, ?, ?)`,
      pU, staff.id, now, now,
    );
    const pO = ulid();
    await dbRun(
      `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, created_at, updated_at)
       VALUES (?, 'p2', 'P2', 'org', ?, ?, ?)`,
      pO, orgId, now, now,
    );
    const vId = ulid();
    await dbRun(
      `INSERT INTO feed_snapshot (id, project_id, state_r2_key, zip_r2_key, zip_size, summary_json, created_at)
       VALUES (?, ?, 's', 'z', 10, '{}', ?)`,
      vId, pU, now,
    );
    await dbRun(
      `INSERT INTO publication (project_id, snapshot_id, published_at, canonical_slug, zip_r2_key)
       VALUES (?, ?, ?, 'p1', 'z')`,
      pU, vId, now,
    );

    const res = await client.get('/api/admin/stats');
    const body = (await res.json()) as Stats;
    expect(body.organizations.total).toBe(1);
    expect(body.projects.total).toBe(2);
    expect(body.projects.byOwnerType.user).toBe(1);
    expect(body.projects.byOwnerType.org).toBe(1);
    expect(body.snapshots.total).toBe(1);
    expect(body.publications.total).toBe(1);
  });

  it('KV cache — same response within TTL even if DB changes', async () => {
    const { client } = await staffClient();

    // Prime the cache.
    const res1 = await client.get('/api/admin/stats');
    const first = (await res1.json()) as Stats;
    expect(first.users.total).toBe(1);

    // Add a user directly — cache should NOT reflect this.
    await seedUser({ email: 'post-cache@example.com' });
    const res2 = await client.get('/api/admin/stats');
    const second = (await res2.json()) as Stats;
    expect(second.users.total).toBe(first.users.total);

    // Manually expire the cache and confirm we see the new user.
    await testEnv.KV.delete('admin:stats');
    const res3 = await client.get('/api/admin/stats');
    const third = (await res3.json()) as Stats;
    expect(third.users.total).toBe(2);
  });

  it('active users tracks distinct session.user_id in windows', async () => {
    const { client, user: staff } = await staffClient();
    const now = Date.now();
    const other = await seedUser({ email: 'sess@example.com' });

    // Manually insert sessions for the other user with different last_used_at.
    // The staff login already created a fresh session with last_used_at=now.
    const sidA = ulid();
    const d10d = now - 10 * 24 * 60 * 60 * 1000;
    await dbRun(
      `INSERT INTO session (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sidA, 'hash-a', other.id, d10d, d10d, now + 86_400_000,
    );
    const sidB = ulid();
    const d40d = now - 40 * 24 * 60 * 60 * 1000;
    await dbRun(
      `INSERT INTO session (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sidB, 'hash-b', other.id, d40d, d40d, now + 86_400_000,
    );

    await testEnv.KV.delete('admin:stats');
    const res = await client.get('/api/admin/stats');
    const body = (await res.json()) as Stats;
    // staff user is active in 24h, 7d, 30d — always.
    // `other` is active in 30d (d10d) but not 24h; fully excluded from 24h.
    expect(body.activeUsers.last24h).toBe(1); // only staff
    expect(body.activeUsers.last7d).toBe(1); // only staff
    expect(body.activeUsers.last30d).toBe(2); // staff + other (d10d)

    // Non-null to satisfy linter on `staff`.
    expect(staff.id).toBeTruthy();
  });
});
