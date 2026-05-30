// Forum ban (staff moderation). The ban is enforced by canWriteToForum
// (banned_until > now); these tests cover the set/lift endpoints, the
// enforcement, the staff gate, the self-ban guard, and bannedUntil visibility.
// See worker/forum/routes.ts (POST/DELETE /profile/:userId/ban).

import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import { applyMigrations, resetDb, seedUser, dbGet, type SeededUser } from './_setup';

async function login(user: SeededUser): Promise<TestClient> {
  const c = makeClient();
  const res = await c.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return c;
}

async function unlockedCategoryId(): Promise<string> {
  const cat = await dbGet<{ id: string }>(`SELECT id FROM forum_category WHERE locked = 0 LIMIT 1`);
  if (!cat) throw new Error('no unlocked forum category seeded');
  return cat.id;
}

describe('forum ban (staff moderation)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('staff bans a member (blocking writes), then lifts it', async () => {
    const staff = await seedUser({ email: 'staff@example.com', staff: true });
    const member = await seedUser({ email: 'member@example.com' });
    const staffC = await login(staff);
    const memberC = await login(member);

    // Member sets a forum display name so the write gate passes on its own.
    expect((await memberC.patch('/api/forum/profile/me', { displayName: 'Member One' })).status).toBe(200);
    const categoryId = await unlockedCategoryId();

    // Pre-ban: the member can post.
    const ok = await memberC.post('/api/forum/threads', { categoryId, title: 'Hello world', bodyMd: 'hi there' });
    expect([200, 201]).toContain(ok.status);

    // Staff bans the member.
    const ban = await staffC.post(`/api/forum/profile/${member.id}/ban`, {});
    expect(ban.status).toBe(200);
    const banBody = (await ban.json()) as { bannedUntil: number };
    expect(banBody.bannedUntil).toBeGreaterThan(Date.now());
    const row = await dbGet<{ banned_until: number }>(
      `SELECT banned_until FROM forum_user_state WHERE user_id = ?`, member.id,
    );
    expect(row?.banned_until).toBeGreaterThan(Date.now());

    // Banned: writes are blocked at the gate (422).
    const blocked = await memberC.post('/api/forum/threads', { categoryId, title: 'Again', bodyMd: 'nope' });
    expect(blocked.status).toBe(422);

    // Staff lifts the ban → the member can post again.
    expect((await staffC.delete(`/api/forum/profile/${member.id}/ban`)).status).toBe(200);
    const ok2 = await memberC.post('/api/forum/threads', { categoryId, title: 'Back again', bodyMd: 'hello' });
    expect([200, 201]).toContain(ok2.status);
  });

  it('non-staff cannot ban; staff cannot ban themselves', async () => {
    const staff = await seedUser({ email: 'staff2@example.com', staff: true });
    const a = await seedUser({ email: 'a@example.com' });
    const b = await seedUser({ email: 'b@example.com' });
    const staffC = await login(staff);
    const aC = await login(a);

    expect((await aC.post(`/api/forum/profile/${b.id}/ban`, {})).status).toBe(403);
    expect((await staffC.post(`/api/forum/profile/${staff.id}/ban`, {})).status).toBe(422);
  });

  it('bannedUntil is exposed to staff viewers only', async () => {
    const staff = await seedUser({ email: 'staff3@example.com', staff: true });
    const member = await seedUser({ email: 'm3@example.com' });
    const staffC = await login(staff);
    expect((await staffC.post(`/api/forum/profile/${member.id}/ban`, {})).status).toBe(200);

    const asStaff = await staffC.json<{ bannedUntil: number | null }>(
      await staffC.get(`/api/forum/profile/${member.id}`),
    );
    expect(typeof asStaff.bannedUntil).toBe('number');

    const anon = makeClient();
    const asAnon = await anon.json<{ bannedUntil?: number | null }>(
      await anon.get(`/api/forum/profile/${member.id}`),
    );
    expect(asAnon.bannedUntil).toBeUndefined();
  });
});
