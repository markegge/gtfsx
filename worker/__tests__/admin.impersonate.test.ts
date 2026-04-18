// /api/admin impersonation: start + end, cookie handling, audit entries.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbAll,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('admin impersonation', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('start → GET /api/me returns the target user; impersonator cookie is set; audit lands on both timelines', async () => {
    const staff = await seedUser({ email: 'staff-i@example.com', staff: true });
    const target = await seedUser({ email: 'target-i@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    // Sanity: currently the staff user.
    const me0 = await client.get('/api/me');
    const m0 = (await me0.json()) as { user: { id: string } };
    expect(m0.user.id).toBe(staff.id);

    const impRes = await client.post(`/api/admin/users/${target.id}/impersonate`);
    expect(impRes.status).toBe(200);

    // Set-Cookie should contain BOTH a new session cookie and the impersonator cookie.
    const setCookies = impRes.headers.getSetCookie?.() ?? [];
    const joined = setCookies.join('\n');
    expect(joined).toMatch(/gb_session=/);
    expect(joined).toMatch(/gb_impersonator=/);

    // Inject the impersonator cookie manually onto the client (the client
    // helper only tracks the first Set-Cookie; for impersonation tests we
    // reconstruct both cookies for subsequent requests).
    const sessionMatch = joined.match(/gb_session=([^;\s]+)/);
    const impMatch = joined.match(/gb_impersonator=([^;\s]+)/);
    expect(sessionMatch).toBeTruthy();
    expect(impMatch).toBeTruthy();
    client.setCookie(`gb_session=${sessionMatch![1]}; gb_impersonator=${impMatch![1]}`);

    // /api/me now returns the target.
    const me1 = await client.get('/api/me');
    const m1 = (await me1.json()) as { user: { id: string; email: string } };
    expect(m1.user.id).toBe(target.id);
    expect(m1.user.email).toBe(target.email);

    // Audit landed on both timelines.
    const auditStaff = await dbAll<{ action: string; actor_user_id: string | null }>(
      `SELECT action, actor_user_id FROM audit_event
         WHERE action = 'admin.impersonate.start' AND subject_type = 'user' AND subject_id = ?`,
      staff.id,
    );
    const auditTarget = await dbAll<{ action: string; actor_user_id: string | null }>(
      `SELECT action, actor_user_id FROM audit_event
         WHERE action = 'admin.impersonate.start' AND subject_type = 'user' AND subject_id = ?`,
      target.id,
    );
    expect(auditStaff.length).toBe(1);
    expect(auditStaff[0].actor_user_id).toBe(staff.id);
    expect(auditTarget.length).toBe(1);
    expect(auditTarget[0].actor_user_id).toBe(staff.id);
  });

  it('end-impersonation restores the staff session + clears impersonator cookie; audit on both timelines', async () => {
    const staff = await seedUser({ email: 'staff-e@example.com', staff: true });
    const target = await seedUser({ email: 'target-e@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });
    const impRes = await client.post(`/api/admin/users/${target.id}/impersonate`);
    expect(impRes.status).toBe(200);

    const setCookies = impRes.headers.getSetCookie?.() ?? [];
    const joined = setCookies.join('\n');
    const sessionMatch = joined.match(/gb_session=([^;\s]+)/);
    const impMatch = joined.match(/gb_impersonator=([^;\s]+)/);
    client.setCookie(`gb_session=${sessionMatch![1]}; gb_impersonator=${impMatch![1]}`);

    // Confirm impersonation is active.
    const me1 = await client.get('/api/me');
    const m1 = (await me1.json()) as { user: { id: string } };
    expect(m1.user.id).toBe(target.id);

    // End impersonation.
    const endRes = await client.post('/api/admin/end-impersonation');
    expect(endRes.status).toBe(204);

    // Pull out new session and confirm impersonator cookie is cleared.
    const endCookies = endRes.headers.getSetCookie?.() ?? [];
    const endJoined = endCookies.join('\n');
    expect(endJoined).toMatch(/gb_session=[^;\s]+/);
    expect(endJoined).toMatch(/gb_impersonator=;/); // cleared

    const newSession = endJoined.match(/gb_session=([^;\s]+)/)![1];
    // The client must NOT send the cleared impersonator cookie.
    client.setCookie(`gb_session=${newSession}`);

    const me2 = await client.get('/api/me');
    const m2 = (await me2.json()) as { user: { id: string; staff: boolean } };
    expect(m2.user.id).toBe(staff.id);
    expect(m2.user.staff).toBe(true);

    const auditStaff = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event
         WHERE action = 'admin.impersonate.end' AND subject_type = 'user' AND subject_id = ?`,
      staff.id,
    );
    const auditTarget = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event
         WHERE action = 'admin.impersonate.end' AND subject_type = 'user' AND subject_id = ?`,
      target.id,
    );
    expect(auditStaff.length).toBe(1);
    expect(auditTarget.length).toBe(1);
  });

  it('end-impersonation without a gb_impersonator cookie → 422', async () => {
    const staff = await seedUser({ email: 'staff-no-cookie@example.com', staff: true });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    const res = await client.post('/api/admin/end-impersonation');
    expect(res.status).toBe(422);
  });

  it('cannot impersonate yourself', async () => {
    const staff = await seedUser({ email: 'selfimp@example.com', staff: true });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    const res = await client.post(`/api/admin/users/${staff.id}/impersonate`);
    expect(res.status).toBe(409);
  });

  it('cannot impersonate a non-active user', async () => {
    const staff = await seedUser({ email: 'staff-inactive@example.com', staff: true });
    const target = await seedUser({ email: 'inactive@example.com', status: 'disabled' });
    const client = makeClient();
    await client.post('/auth/login', { email: staff.email, password: staff.password });

    const res = await client.post(`/api/admin/users/${target.id}/impersonate`);
    expect(res.status).toBe(409);
  });
});
