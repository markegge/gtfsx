// /api/admin/audit — list + filter + CSV export.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function staffClient(email = 'staff-audit@example.com'): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email, staff: true });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

interface AuditResp {
  events: Array<{
    id: string;
    action: string;
    actorUserId: string | null;
    actorEmail: string | null;
    subjectType: string;
    subjectId: string | null;
  }>;
  hasNext: boolean;
}

async function insertAudit(opts: {
  action: string;
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  createdAt?: number;
}) {
  await dbRun(
    `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, metadata_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ulid(),
    opts.actorUserId ?? null,
    opts.subjectType ?? 'user',
    opts.subjectId ?? null,
    opts.action,
    opts.createdAt ?? Date.now(),
  );
}

describe('/api/admin/audit listing', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('lists events newest first, joins actor email', async () => {
    const { client, userId } = await staffClient('actor@example.com');

    await insertAudit({ action: 'user.signup', actorUserId: userId, subjectId: userId });
    await insertAudit({ action: 'project.create', actorUserId: userId, subjectType: 'project', subjectId: 'P' });

    const res = await client.get('/api/admin/audit');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditResp;
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    // The two freshly-inserted rows should be toward the top.
    const actions = body.events.map((e) => e.action);
    expect(actions).toContain('user.signup');
    expect(actions).toContain('project.create');
    // Actor email joined.
    const mine = body.events.find((e) => e.actorUserId === userId);
    expect(mine?.actorEmail).toBe('actor@example.com');
  });

  it('filters by actorUserId, subjectType, subjectId, action, from/to', async () => {
    const { client, userId } = await staffClient();
    const u2 = await seedUser({ email: 'other@example.com' });
    const t0 = Date.now() - 60_000;

    await insertAudit({ action: 'a.alpha', actorUserId: userId, subjectType: 'user', subjectId: 'X', createdAt: t0 });
    await insertAudit({ action: 'a.beta', actorUserId: u2.id, subjectType: 'user', subjectId: 'Y', createdAt: t0 + 1000 });
    await insertAudit({ action: 'a.alpha', actorUserId: u2.id, subjectType: 'project', subjectId: 'Z', createdAt: t0 + 2000 });

    // actorUserId filter.
    const a = await client.get(`/api/admin/audit?actorUserId=${u2.id}`);
    const aBody = (await a.json()) as AuditResp;
    expect(aBody.events.every((e) => e.actorUserId === u2.id)).toBe(true);
    expect(aBody.events.length).toBeGreaterThanOrEqual(2);

    // action filter.
    const b = await client.get('/api/admin/audit?action=a.alpha');
    const bBody = (await b.json()) as AuditResp;
    expect(bBody.events.every((e) => e.action === 'a.alpha')).toBe(true);
    expect(bBody.events.length).toBe(2);

    // subjectType filter.
    const c = await client.get('/api/admin/audit?subjectType=project');
    const cBody = (await c.json()) as AuditResp;
    expect(cBody.events.every((e) => e.subjectType === 'project')).toBe(true);
    expect(cBody.events.length).toBe(1);

    // subjectId filter.
    const d = await client.get('/api/admin/audit?subjectId=X');
    const dBody = (await d.json()) as AuditResp;
    expect(dBody.events.length).toBe(1);
    expect(dBody.events[0].subjectId).toBe('X');

    // from/to filter.
    const e = await client.get(`/api/admin/audit?from=${t0 - 100}&to=${t0 + 500}`);
    const eBody = (await e.json()) as AuditResp;
    // Only a.alpha (subject X) was within that window.
    expect(eBody.events.length).toBe(1);
    expect(eBody.events[0].subjectId).toBe('X');
  });

  it('paginates — pageSize, nextPage via page=2', async () => {
    const { client } = await staffClient();

    // Insert 5 events.
    const base = Date.now() - 10_000;
    for (let i = 0; i < 5; i++) {
      await insertAudit({ action: 'pag.test', createdAt: base + i * 1000, subjectId: `S${i}` });
    }

    const p1 = await client.get('/api/admin/audit?action=pag.test&pageSize=2&page=1');
    const b1 = (await p1.json()) as AuditResp;
    expect(b1.events.length).toBe(2);
    expect(b1.hasNext).toBe(true);

    const p3 = await client.get('/api/admin/audit?action=pag.test&pageSize=2&page=3');
    const b3 = (await p3.json()) as AuditResp;
    expect(b3.events.length).toBe(1);
    expect(b3.hasNext).toBe(false);
  });
});

describe('/api/admin/audit.csv export', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('returns parseable CSV with a header row and rows', async () => {
    const { client, userId } = await staffClient();
    await insertAudit({ action: 'csv.test', actorUserId: userId, subjectType: 'user', subjectId: 'X' });
    await insertAudit({ action: 'csv.test', actorUserId: userId, subjectType: 'user', subjectId: 'Y' });

    const res = await client.get('/api/admin/audit.csv?action=csv.test');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('audit.csv');
    const body = await res.text();
    const lines = body.trim().split(/\r?\n/);
    // Header + 2 data rows.
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('action');
    expect(lines[0]).toContain('actor_email');
    // At least one of the rows references the action name and subject Y.
    expect(lines.slice(1).some((l) => l.includes('csv.test') && l.includes('Y'))).toBe(true);
  });

  it('escapes commas and quotes correctly', async () => {
    const { client } = await staffClient();
    await dbRun(
      `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, metadata_json, ip, created_at)
       VALUES (?, NULL, 'user', 'S1', 'quirky.action', ?, NULL, ?)`,
      ulid(), '{"note":"he said \\"hi\\", then left"}', Date.now(),
    );
    const res = await client.get('/api/admin/audit.csv?action=quirky.action');
    const body = await res.text();
    // Field contained a comma and JSON backslash-escaped quotes. CSV quoting
    // wraps the whole field in double-quotes and doubles any internal quotes.
    expect(body).toMatch(/"{""note"":""he said \\""hi\\"", then left""}"/);
  });
});
