// /api/me/audit visibility rules:
//   - user sees events where they are the subject OR the actor
//   - user sees events about projects they own
//   - user does NOT see another user's unrelated events
//   - /api/projects/:id/audit is gated on project ownership

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

interface AuditEvent {
  id: string;
  actorUserId: string | null;
  subjectType: string;
  subjectId: string | null;
  action: string;
  metadataJson: string | null;
  createdAt: number;
}

describe('/api/me/audit', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('returns login + project.create events where the user is actor/subject', async () => {
    const { client, userId } = await loggedInClient('audit1@example.com');
    await client.post('/api/projects', { name: 'Feed Alpha' });

    const res = await client.get('/api/me/audit');
    expect(res.status).toBe(200);
    const body = await client.json<{ events: AuditEvent[] }>(res);

    // We should see a session.login (actor=user) and a project.create (actor=user).
    const actions = body.events.map((e) => e.action);
    expect(actions).toContain('session.login');
    expect(actions).toContain('project.create');
    // Every returned event must reference this user somehow.
    for (const e of body.events) {
      const touchesUser =
        e.actorUserId === userId ||
        (e.subjectType === 'user' && e.subjectId === userId) ||
        e.subjectType === 'project';
      expect(touchesUser).toBe(true);
    }
  });

  it('does not leak events between users', async () => {
    // Alice creates a project; Bob signs in and fetches his audit log.
    const alice = await loggedInClient('alice-audit@example.com');
    await alice.client.post('/api/projects', { name: 'Alice Secret Feed' });

    const bob = await loggedInClient('bob-audit@example.com');
    const res = await bob.client.get('/api/me/audit');
    const body = await bob.client.json<{ events: AuditEvent[] }>(res);

    for (const e of body.events) {
      // None of Bob's events should mention Alice's user id.
      expect(e.actorUserId).not.toBe(alice.userId);
      if (e.subjectType === 'user') {
        expect(e.subjectId).not.toBe(alice.userId);
      }
    }
    // Bob should at minimum see his own session.login.
    expect(body.events.some((e) => e.action === 'session.login')).toBe(true);
  });

  it('includes events on the user\'s own projects (project-linked visibility)', async () => {
    const { client } = await loggedInClient('audit-proj@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Feed Alpha' }),
    );
    // Trigger a second project event so we have something specific to look for.
    await client.patch(`/api/projects/${proj.id}`, { name: 'Feed Alpha 2' });

    const res = await client.get('/api/me/audit');
    const body = await client.json<{ events: AuditEvent[] }>(res);

    const projectEvents = body.events.filter(
      (e) => e.subjectType === 'project' && e.subjectId === proj.id,
    );
    expect(projectEvents.some((e) => e.action === 'project.create')).toBe(true);
    expect(projectEvents.some((e) => e.action === 'project.update')).toBe(true);
  });

  it('/api/projects/:id/audit is gated on ownership — cross-user is 404', async () => {
    const alice = await loggedInClient('alice-paudit@example.com');
    const proj = await alice.client.json<{ id: string }>(
      await alice.client.post('/api/projects', { name: 'Private' }),
    );

    // Alice can read her own project audit.
    const own = await alice.client.get(`/api/projects/${proj.id}/audit`);
    expect(own.status).toBe(200);
    const ownBody = await alice.client.json<{ events: AuditEvent[] }>(own);
    expect(ownBody.events.some((e) => e.action === 'project.create')).toBe(true);

    // Bob cannot read Alice's project audit.
    const bob = await loggedInClient('bob-paudit@example.com');
    const res = await bob.client.get(`/api/projects/${proj.id}/audit`);
    expect(res.status).toBe(404);
  });

  it('respects limit & before pagination parameters', async () => {
    const { client } = await loggedInClient('audit-page@example.com');
    // Generate several events by creating projects.
    for (let i = 0; i < 5; i += 1) {
      await client.post('/api/projects', { name: `Feed ${i}` });
    }

    const first = await client.json<{ events: AuditEvent[] }>(
      await client.get('/api/me/audit?limit=2'),
    );
    expect(first.events.length).toBe(2);
    // Events are returned newest-first; pass the oldest id seen as `before=` to page.
    const cursor = first.events[first.events.length - 1].id;
    const second = await client.json<{ events: AuditEvent[] }>(
      await client.get(`/api/me/audit?limit=2&before=${cursor}`),
    );
    expect(second.events.length).toBeGreaterThan(0);
    // Pages must not overlap.
    const firstIds = new Set(first.events.map((e) => e.id));
    for (const e of second.events) expect(firstIds.has(e.id)).toBe(false);
  });
});
