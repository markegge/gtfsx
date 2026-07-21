// POST /api/demo-leads — demo-request lead form submit.
//
// Backs the /book-demo lead form (worker/marketing/bookDemo.ts). On a valid
// submit we:
//   1. store the lead in D1 (`demo_leads`, migration 0026),
//   2. emit the Google Ads `demo_request` conversion into the cookieless
//      `event` table — gclid-stamped, src → label, same conventions the old
//      GET /book-demo redirect used. This is now THE conversion emission; the
//      event name stays EXACTLY `demo_request` so the OCI cron
//      (worker/marketing/ads/oci.ts) and its Google Ads conversion action keep
//      working unchanged, and
//   3. best-effort notify the owner inbox (never blocks the request).
//
// Bot defenses: a hidden honeypot field, server-side Turnstile verification
// (when the site key is configured — see below), and an IP rate limit. Lives
// under /api so it inherits the X-GB-Client CSRF header check + JSON error
// conventions, same as the analytics beacon (/api/events/track).

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext } from '../env';
import { insertEvent } from '../events/insert';
import { verifyTurnstile } from '../util/turnstile';
import { validationFailed } from '../util/errors';
import { clientIp, rateLimit } from '../util/rateLimit';
import { sendDemoLeadNotification } from '../email';
import { errorDetail } from '../util/redact';

// Caps mirror the signup/TrackSchema limits: email ≤254, label(src) ≤128,
// gclid ≤256, ref ≤128. Honeypot + campaign fields are optional strings the
// client always sends (possibly empty); we null out empties after parsing.
const DemoLeadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  org: z.string().trim().min(1).max(160),
  message: z.string().trim().max(2000).optional(),
  src: z.string().max(128).optional(),
  gclid: z.string().max(256).optional(),
  gbraid: z.string().max(256).optional(),
  wbraid: z.string().max(256).optional(),
  ref: z.string().max(128).optional(),
  // Honeypot — real users leave it empty. Bots that fill every field trip it.
  company_website: z.string().max(200).optional(),
  // Turnstile response token (present only when the widget rendered).
  turnstileToken: z.string().max(2048).optional(),
});

type DemoLeadBody = z.infer<typeof DemoLeadSchema>;

// Trim + cap → null when empty, so optional campaign fields land as NULL.
function emptyToNull(value: string | undefined, maxLen: number): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : null;
}

// `event.session_id` is NOT NULL and there's no client beacon session on this
// form POST — mint a random id per event (same shape as the client's, see
// src/services/trackBeacon.ts).
function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function parseJson(c: { req: { json: () => Promise<unknown> } }): Promise<DemoLeadBody> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = DemoLeadSchema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

export const demoLeadRouter = new Hono<AppContext>();

demoLeadRouter.post('/', async (c) => {
  const body = await parseJson(c);

  // Honeypot: silently accept-and-drop so a bot can't tell it was caught.
  // Checked before the rate limit so honeypot floods can't burn a real
  // visitor's IP budget, and returns the same success shape as a real submit.
  if (body.company_website && body.company_website.trim().length > 0) {
    return c.json({ ok: true });
  }

  // Verify Turnstile only when the site key is configured (the widget rendered
  // and a token is expected) — done before the rate limit so a bot that can't
  // solve the challenge is rejected without burning KV. When the site key is
  // absent the form submits without a token and we skip verification to match,
  // mirroring how signup couples the site key ⟺ TURNSTILE_SECRET_KEY per
  // environment (the honeypot + rate limit still apply in that window).
  // verifyTurnstile itself also no-ops when TURNSTILE_SECRET_KEY is unset
  // (dev / tests).
  if (c.env.TURNSTILE_SITE_KEY) {
    await verifyTurnstile(c.env, body.turnstileToken, clientIp(c.req.raw));
  }

  // 20 submits/hour/IP: a real requester submits once; higher is spam.
  await rateLimit(c.env, {
    key: `demo-lead:${clientIp(c.req.raw)}`,
    limit: 20,
    windowSec: 3600,
  });

  const src = emptyToNull(body.src, 128);
  const gclid = emptyToNull(body.gclid, 256);
  const gbraid = emptyToNull(body.gbraid, 256);
  const wbraid = emptyToNull(body.wbraid, 256);
  const ref = emptyToNull(body.ref, 128);
  const message = emptyToNull(body.message, 2000);
  const country = c.req.header('CF-IPCountry') ?? null;

  // 1. Durable lead record.
  await c.env.DB.prepare(
    `INSERT INTO demo_leads (id, created_at, name, email, org, message, src, gclid, ref, gbraid, wbraid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ulid(), Date.now(), body.name, body.email, body.org, message, src, gclid, ref, gbraid, wbraid)
    .run();

  // 2. Google Ads conversion — same field conventions the old GET used
  //    (src → label, gclid, ref); event name is load-bearing (OCI cron).
  await insertEvent(c.env.DB, {
    kind: 'demo_request',
    path: '/book-demo',
    ref,
    sessionId: randomSessionId(),
    country,
    label: src,
    gclid,
    gbraid,
    wbraid,
  });

  // 3. Best-effort owner notification. A Resend hiccup must not fail the
  //    request — the lead is already saved.
  try {
    await sendDemoLeadNotification(c.env, {
      name: body.name,
      email: body.email,
      org: body.org,
      message,
      src,
    });
  } catch (err) {
    console.error(`[demo-lead] owner notification failed: ${errorDetail(err)}`);
  }

  return c.json({ ok: true });
});
