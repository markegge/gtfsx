// GET /api/admin/warm-cohort.csv — the ranked founder-outreach export.
// Covers: admin/staff gating, exact CSV header shape, ranking order (a single
// pro_intent row outranks an otherwise-strong feeds-only account), and the
// at_free_cap / org_name / exported / has_flex_zones derivations.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function staffClient(email = 'staff@example.com') {
  const user = await seedUser({ email, staff: true });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, user };
}

const HEADER =
  'email,account_created_at,last_active_at,org_name,saved_feeds_count,at_free_cap,' +
  'exported_gtfs_count,has_flex_zones,distinct_active_days_30d,sessions_last_30d,' +
  'attempted_pro_action,is_consultant_signal,score';

async function seedFeed(
  ownerId: string,
  name: string,
  slug: string,
  ts: number = Date.now(),
): Promise<void> {
  await dbRun(
    `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, working_state_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
    ulid(), slug, name, ownerId, ts, ts, ts,
  );
}

async function seedIntent(userId: string, action: string, ts: number, source: string | null = null): Promise<void> {
  await dbRun(
    `INSERT INTO pro_intent (id, user_id, ts, action, source) VALUES (?, ?, ?, ?, ?)`,
    ulid(), userId, ts, action, source,
  );
}

/** Parse the CSV into a header + array of {colName: value} rows (test data is comma-free in cells). */
function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const obj: Record<string, string> = {};
    header.forEach((h, i) => (obj[h] = cells[i] ?? ''));
    return obj;
  });
  return { header, rows };
}

describe('GET /api/admin/warm-cohort.csv', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  // ─── Gating (the SAME requireAuth + requireStaff guard as every /api/admin/*
  // route). requireStaff returns 404 (not 403) by design — it avoids
  // advertising the admin surface to non-staff. So "403 for non-staff" in the
  // spec is realized as a 404 here; we assert the guard's real behavior. ───────

  it('unauthenticated → 401', async () => {
    const client = makeClient();
    const res = await client.get('/api/admin/warm-cohort.csv');
    expect(res.status).toBe(401);
  });

  it('authenticated non-staff → 404 (admin surface hidden)', async () => {
    const user = await seedUser({ email: 'nonstaff@example.com', staff: false });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    const res = await client.get('/api/admin/warm-cohort.csv');
    expect(res.status).toBe(404);
    // No CSV leaked to a non-staff caller.
    expect(res.headers.get('Content-Type') ?? '').not.toContain('text/csv');
  });

  it('staff → 200 text/csv attachment with the exact header shape', async () => {
    const { client } = await staffClient();
    const res = await client.get('/api/admin/warm-cohort.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="warm-cohort.csv"');

    const { header } = parseCsv(await res.text());
    expect(header.join(',')).toBe(HEADER);
  });

  it('ranks a pro_intent account above an otherwise-strong feeds-only account', async () => {
    const { client } = await staffClient();
    const now = Date.now();

    // HOT: free user, ZERO feeds, but ONE pro_intent (checkout_started). The
    // single hottest signal — should top the list.
    const hot = await seedUser({ email: 'hot@example.com', plan: 'free' });
    await seedIntent(hot.id, 'checkout_started', now - 1000, 'pricing_page');

    // STRONG-BUT-COLD: free consultant at the 3-feed cap, three distinct agency
    // feeds, recently active — lights up at_free_cap + consultant + repeat-use,
    // but NEVER reached for a Pro action. Must rank BELOW hot.
    const cold = await seedUser({ email: 'lead@transit-consult.com', plan: 'free' });
    await seedFeed(cold.id, 'Metro Agency', 'metro', now - 2 * 86_400_000);
    await seedFeed(cold.id, 'Valley Transit', 'valley', now - 1 * 86_400_000);
    await seedFeed(cold.id, 'Coastal Lines', 'coastal', now);

    // A low-signal individual (freemail) with one stale feed.
    const indiv = await seedUser({ email: 'casual@gmail.com', plan: 'free' });
    await seedFeed(indiv.id, 'My Feed', 'myfeed', now - 200 * 86_400_000);

    const res = await client.get('/api/admin/warm-cohort.csv');
    expect(res.status).toBe(200);
    const { rows } = parseCsv(await res.text());

    const order = rows.map((r) => r.email);
    const iHot = order.indexOf('hot@example.com');
    const iCold = order.indexOf('lead@transit-consult.com');
    const iIndiv = order.indexOf('casual@gmail.com');

    expect(iHot).toBeGreaterThanOrEqual(0);
    expect(iCold).toBeGreaterThanOrEqual(0);
    // Hot (pro_intent) ranks above the strong feeds-only consultant…
    expect(iHot).toBeLessThan(iCold);
    // …and the cold consultant still beats the low-signal individual.
    expect(iCold).toBeLessThan(iIndiv);

    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));

    // Hot: not at cap (0 feeds), exported proxy counts the checkout intent,
    // attempted_pro_action shows count + most-recent action.
    expect(byEmail['hot@example.com'].at_free_cap).toBe('false');
    expect(byEmail['hot@example.com'].exported_gtfs_count).toBe('1');
    expect(byEmail['hot@example.com'].attempted_pro_action).toContain('1');
    expect(byEmail['hot@example.com'].attempted_pro_action).toContain('checkout_started');
    expect(Number(byEmail['hot@example.com'].score)).toBeGreaterThan(
      Number(byEmail['lead@transit-consult.com'].score),
    );

    // Cold consultant: at the free cap, flagged consultant, org_name = bare
    // domain (non-freemail, no org membership), flex best-effort false.
    expect(byEmail['lead@transit-consult.com'].at_free_cap).toBe('true');
    expect(byEmail['lead@transit-consult.com'].saved_feeds_count).toBe('3');
    expect(byEmail['lead@transit-consult.com'].is_consultant_signal).toBe('true');
    expect(byEmail['lead@transit-consult.com'].org_name).toBe('transit-consult.com');
    expect(byEmail['lead@transit-consult.com'].has_flex_zones).toBe('false');

    // Individual: freemail → org_name 'individual', not a consultant.
    expect(byEmail['casual@gmail.com'].org_name).toBe('individual');
    expect(byEmail['casual@gmail.com'].is_consultant_signal).toBe('false');
  });

  it('org members get the matched org name (not the bare domain)', async () => {
    const { client } = await staffClient();
    const now = Date.now();

    const member = await seedUser({ email: 'pm@bigcity.gov', plan: 'pro' });
    const orgId = ulid();
    await dbRun(
      `INSERT INTO organization (id, slug, name, created_at) VALUES (?, 'bigcity', 'Big City DOT', ?)`,
      orgId, now,
    );
    await dbRun(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      orgId, member.id, now,
    );

    const res = await client.get('/api/admin/warm-cohort.csv');
    const { rows } = parseCsv(await res.text());
    const row = rows.find((r) => r.email === 'pm@bigcity.gov');
    expect(row?.org_name).toBe('Big City DOT');
  });
});
