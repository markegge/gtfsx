// The /book-demo demo-request funnel:
//   - GET /book-demo renders the lead form (worker-rendered, noindex) and
//     writes NO conversion event for anyone (bots included) — the conversion
//     moved to the submit.
//   - POST /api/demo-leads is the submit: it stores a `demo_leads` row, emits
//     the gclid-stamped `demo_request` conversion into `event` (src → label,
//     ref, path=/book-demo), and best-effort notifies the owner. Honeypot
//     submissions are silently accepted-and-dropped; bad input is rejected; an
//     owner-email failure never fails the request; and a failed Turnstile
//     challenge (when configured) is rejected before any write.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, dbAll, dbRun, resetDb, setupEmailCapture } from './_setup';
import { DEMO_BOOKING_URL } from '../marketing/bookDemo';
import { demoLeadRouter } from '../marketing/demoLead';
import type { Env } from '../env';

// Assert the literal destination (not just the imported constant) so a typo in
// the constant itself fails loudly here.
const EXPECTED_BOOKING_URL = 'https://fantastical.app/markegge/gtfsx-demo';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

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

interface LeadRow {
  id: string;
  created_at: number;
  name: string;
  email: string;
  org: string | null;
  message: string | null;
  src: string | null;
  gclid: string | null;
  ref: string | null;
}

async function eventRows(): Promise<EventRow[]> {
  return dbAll<EventRow>(`SELECT * FROM event`);
}
async function leadRows(): Promise<LeadRow[]> {
  return dbAll<LeadRow>(`SELECT * FROM demo_leads`);
}

beforeEach(async () => {
  await applyMigrations();
  await resetDb();
  // resetDb() doesn't truncate `event` or the new `demo_leads` table (both live
  // outside the user/project graph) — wipe them here for deterministic state.
  await dbRun(`DELETE FROM event`);
  await dbRun(`DELETE FROM demo_leads`);
});

describe('GET /book-demo (lead form)', () => {
  it('renders the noindex lead form and writes no conversion event', async () => {
    const client = makeClient();
    const res = await client.get('/book-demo?src=pricing_hero&gclid=EAIaGclid123', {
      headers: { 'User-Agent': BROWSER_UA },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');

    const html = await res.text();
    expect(html).toContain('See GTFS·X in action');
    // The booking calendar is offered on the page (skip-ahead + thank-you).
    expect(html).toContain(EXPECTED_BOOKING_URL);
    expect(DEMO_BOOKING_URL).toBe(EXPECTED_BOOKING_URL);
    // It posts to the lead endpoint, not a redirect.
    expect(html).toContain('/api/demo-leads');

    expect(await eventRows()).toHaveLength(0);
  });

  it('serves the form on the trailing-slash path too', async () => {
    const client = makeClient();
    const res = await client.get('/book-demo/?src=footer', {
      headers: { 'User-Agent': BROWSER_UA },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('See GTFS·X in action');
  });

  it.each([
    ['a browser', BROWSER_UA],
    ['a crawler', GOOGLEBOT_UA],
    ['no user-agent', undefined],
  ])('writes no event on GET for %s', async (_label, ua) => {
    const client = makeClient();
    const res = await client.get('/book-demo?src=ads&gclid=g1', {
      headers: ua ? { 'User-Agent': ua } : {},
    });
    expect(res.status).toBe(200);
    expect(await eventRows()).toHaveLength(0);
  });
});

describe('POST /api/demo-leads (submit)', () => {
  // No TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY in the test env, so the handler
  // skips Turnstile verification (matching a page whose widget didn't render).
  // The dedicated Turnstile-failure case below drives verification directly.

  it('stores the lead + emits the demo_request conversion, then notifies the owner', async () => {
    const capture = setupEmailCapture();
    try {
      const client = makeClient();
      const res = await client.post('/api/demo-leads', {
        name: 'Dana Rivera',
        email: 'Dana@Metro.GOV',
        org: 'Metro Transit',
        message: 'Curious about GTFS-Flex support.',
        src: 'pricing_hero',
        gclid: 'EAIaGclidDemo',
        ref: 'https://www.gtfsx.com/pricing',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const leads = await leadRows();
      expect(leads).toHaveLength(1);
      expect(leads[0].name).toBe('Dana Rivera');
      expect(leads[0].email).toBe('dana@metro.gov'); // normalized lowercase
      expect(leads[0].org).toBe('Metro Transit');
      expect(leads[0].message).toBe('Curious about GTFS-Flex support.');
      expect(leads[0].src).toBe('pricing_hero');
      expect(leads[0].gclid).toBe('EAIaGclidDemo');
      expect(leads[0].ref).toBe('https://www.gtfsx.com/pricing');

      const events = await eventRows();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('demo_request');
      expect(events[0].path).toBe('/book-demo');
      expect(events[0].label).toBe('pricing_hero'); // src → label
      expect(events[0].gclid).toBe('EAIaGclidDemo');
      expect(events[0].ref).toBe('https://www.gtfsx.com/pricing');
      expect(events[0].session_id.length).toBeGreaterThanOrEqual(8);

      // Owner notification: to the owner inbox, reply-to the lead.
      expect(capture.emails).toHaveLength(1);
      expect(capture.emails[0].to).toBe('owner@example.com');
      expect(capture.emails[0].reply_to).toBe('dana@metro.gov');
      expect(capture.emails[0].subject).toContain('Metro Transit');
    } finally {
      capture.restore();
    }
  });

  it('stores NULLs for omitted optional fields', async () => {
    const client = makeClient();
    const res = await client.post('/api/demo-leads', {
      name: 'Sam Lee',
      email: 'sam@example.org',
      org: 'Rural RTA',
    });
    expect(res.status).toBe(200);

    const leads = await leadRows();
    expect(leads).toHaveLength(1);
    expect(leads[0].message).toBeNull();
    expect(leads[0].src).toBeNull();
    expect(leads[0].gclid).toBeNull();
    expect(leads[0].ref).toBeNull();

    const events = await eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].label).toBeNull();
    expect(events[0].gclid).toBeNull();
  });

  it('silently accepts and drops a honeypot submission (no writes)', async () => {
    const capture = setupEmailCapture();
    try {
      const client = makeClient();
      const res = await client.post('/api/demo-leads', {
        name: 'Spam Bot',
        email: 'spam@bot.example',
        org: 'Bot Co',
        company_website: 'http://spammy.example', // honeypot filled
      });
      // Success-shaped so a bot can't tell it was caught.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(await leadRows()).toHaveLength(0);
      expect(await eventRows()).toHaveLength(0);
      expect(capture.emails).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  it('rejects an invalid email (422) and writes nothing', async () => {
    const client = makeClient();
    const res = await client.post('/api/demo-leads', {
      name: 'Bad Email',
      email: 'not-an-email',
      org: 'Somewhere',
    });
    expect(res.status).toBe(422);
    expect(await leadRows()).toHaveLength(0);
    expect(await eventRows()).toHaveLength(0);
  });

  it('rejects a missing required field (422)', async () => {
    const client = makeClient();
    const res = await client.post('/api/demo-leads', {
      name: 'No Org',
      email: 'noorg@example.com',
      // org omitted
    });
    expect(res.status).toBe(422);
    expect(await leadRows()).toHaveLength(0);
  });

  it('rejects an over-long name (422)', async () => {
    const client = makeClient();
    const res = await client.post('/api/demo-leads', {
      name: 'x'.repeat(121),
      email: 'long@example.com',
      org: 'Metro',
    });
    expect(res.status).toBe(422);
    expect(await leadRows()).toHaveLength(0);
  });

  it('still succeeds (200) with the lead + event written when the owner email fails', async () => {
    const capture = setupEmailCapture();
    capture.simulateSendFailure(500, '{"error":"resend down"}');
    try {
      const client = makeClient();
      const res = await client.post('/api/demo-leads', {
        name: 'Pat Doe',
        email: 'pat@example.com',
        org: 'City DOT',
        gclid: 'gEmailFail',
      });
      expect(res.status).toBe(200);
      // The lead is already durably saved and the conversion emitted.
      expect(await leadRows()).toHaveLength(1);
      const events = await eventRows();
      expect(events).toHaveLength(1);
      expect(events[0].gclid).toBe('gEmailFail');
    } finally {
      capture.restore();
    }
  });

  it('does not gate POST on User-Agent (bots are stopped by Turnstile/honeypot, not UA)', async () => {
    const client = makeClient();
    const res = await client.post(
      '/api/demo-leads',
      { name: 'Real Person', email: 'real@example.com', org: 'Transit Co' },
      { headers: { 'User-Agent': GOOGLEBOT_UA } },
    );
    expect(res.status).toBe(200);
    expect(await leadRows()).toHaveLength(1);
  });
});

describe('POST /api/demo-leads Turnstile enforcement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects the submit when Turnstile verification fails', async () => {
    // Intercept the Cloudflare siteverify call and force a rejection.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) {
          return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch to ${url}`);
      },
    );

    // Both keys set => verification runs. No DB/KV is touched because the
    // rejection happens before any write, so a minimal env suffices.
    const env = {
      TURNSTILE_SITE_KEY: 'site-key',
      TURNSTILE_SECRET_KEY: 'secret-key',
    } as unknown as Env;

    const res = await demoLeadRouter.request(
      '/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Challenge Failer',
          email: 'challenge@example.com',
          org: 'Bot Farm',
          turnstileToken: 'bad-token',
        }),
      },
      env,
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });
});
