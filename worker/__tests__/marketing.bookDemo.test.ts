// GET /book-demo — demo-booking funnel redirect. Asserts: a demo_request
// event row is written (src → label, gclid, Referer → ref, CF-IPCountry →
// country), the 302 to the booking page always happens, bot user-agents are
// redirected without logging, missing params are tolerated, and a DB failure
// never blocks the redirect.

import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, dbAll, dbRun, resetDb } from './_setup';
import { DEMO_BOOKING_URL, handleBookDemo } from '../marketing/bookDemo';
import type { Env } from '../env';

// Assert the literal destination (not the imported constant) so a typo in
// the constant itself fails loudly here.
const EXPECTED_LOCATION = 'https://fantastical.app/markegge/gtfsx-demo';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface EventRow {
  id: string;
  kind: string;
  path: string;
  ref: string | null;
  session_id: string;
  country: string | null;
  label: string | null;
  gclid: string | null;
}

async function eventRows(): Promise<EventRow[]> {
  return dbAll<EventRow>(`SELECT * FROM event`);
}

describe('GET /book-demo', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    // resetDb() doesn't truncate `event` (analytics rows live outside the
    // user/project graph) — wipe it here for deterministic state.
    await dbRun(`DELETE FROM event`);
  });

  it('records a demo_request event with src + gclid, then 302s to the booking page', async () => {
    const client = makeClient();
    const res = await client.get('/book-demo?src=pricing_hero&gclid=EAIaIQobChMIdemo123', {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': 'https://www.gtfsx.com/pricing',
        'CF-IPCountry': 'US',
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(EXPECTED_LOCATION);
    expect(DEMO_BOOKING_URL).toBe(EXPECTED_LOCATION);

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('demo_request');
    expect(rows[0].path).toBe('/book-demo');
    expect(rows[0].label).toBe('pricing_hero');
    expect(rows[0].gclid).toBe('EAIaIQobChMIdemo123');
    expect(rows[0].ref).toBe('https://www.gtfsx.com/pricing');
    expect(rows[0].country).toBe('US');
    // A per-event random session id satisfies the NOT NULL column.
    expect(rows[0].session_id.length).toBeGreaterThanOrEqual(8);
  });

  it('tolerates missing src/gclid/Referer — event row has NULLs, redirect unchanged', async () => {
    const client = makeClient();
    const res = await client.get('/book-demo', {
      headers: { 'User-Agent': BROWSER_UA },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(EXPECTED_LOCATION);

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('demo_request');
    expect(rows[0].label).toBeNull();
    expect(rows[0].gclid).toBeNull();
    expect(rows[0].ref).toBeNull();
  });

  it('works with a trailing slash', async () => {
    const client = makeClient();
    const res = await client.get('/book-demo/?src=footer', {
      headers: { 'User-Agent': BROWSER_UA },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(EXPECTED_LOCATION);
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('footer');
  });

  it('caps an over-long src at 128 chars', async () => {
    const client = makeClient();
    const longSrc = 'x'.repeat(300);
    const res = await client.get(`/book-demo?src=${longSrc}`, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    expect(res.status).toBe(302);
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('x'.repeat(128));
  });

  it.each([
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
    ['curl', 'curl/8.6.0'],
    ['python-requests', 'python-requests/2.32.0'],
  ])('bot UA (%s) still 302s but writes no event row', async (_name, ua) => {
    const client = makeClient();
    const res = await client.get('/book-demo?src=ads&gclid=g1', {
      headers: { 'User-Agent': ua },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(EXPECTED_LOCATION);
    expect(await eventRows()).toHaveLength(0);
  });

  it('missing User-Agent is treated as a bot: 302, no event row', async () => {
    const client = makeClient();
    const res = await client.get('/book-demo?src=ads');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(EXPECTED_LOCATION);
    expect(await eventRows()).toHaveLength(0);
  });

  it('still redirects when the event insert throws (analytics never blocks booking)', async () => {
    // Unit-level: hand the handler an env whose DB explodes on prepare().
    const explodingEnv = {
      DB: {
        prepare() {
          throw new Error('D1 is down');
        },
      },
    } as unknown as Env;

    const req = new Request('https://www.gtfsx.com/book-demo?src=pricing_hero', {
      headers: { 'User-Agent': BROWSER_UA },
    });
    const res = await handleBookDemo(req, explodingEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(EXPECTED_LOCATION);
  });
});
