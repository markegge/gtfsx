import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../env';
import { insertEvent } from './insert';
import { validationFailed } from '../util/errors';
import { clientIp, rateLimit } from '../util/rateLimit';

// ─── Public, cookieless event ingestion ────────────────────────────────────
//
// One row per page view. No PII stored: no IP, no User-Agent, no user id.
// `session_id` is a random value the client holds in sessionStorage — it
// scopes a "visit" without using a cookie. The `ref` field is captured once
// per session from the `?ref=` query parameter on the inbound URL.
//
// CSRF protection via the global requireClientHeader middleware on /api/* is
// still in effect: legitimate calls send X-GB-Client: web and the beacon uses
// `fetch(..., { keepalive: true })` to survive page unload while keeping the
// header. We don't accept cross-origin POSTs.

const TrackSchema = z.object({
  // page_view is the original signal; the others feed the marketing funnel
  // (editor sessions, exports, paywall intent, marketing-CTA clicks). See
  // migration 0013. `kind` is a plain TEXT column — new kinds need no migration.
  // demo_request is normally written server-side by the /book-demo lead-form
  // submit (POST /api/demo-leads, worker/marketing/demoLead.ts); it's listed
  // here for kind parity with src/services/trackBeacon.ts — the client has no
  // beacon call site for it.
  kind: z.enum(['page_view', 'editor_loaded', 'feed_exported', 'paywall_view', 'cta_click', 'demo_request']),
  path: z.string().min(1).max(512),
  ref: z.string().min(1).max(128).nullable().optional(),
  sessionId: z.string().min(8).max(64),
  // Optional sub-type, e.g. the feature key behind a paywall_view.
  label: z.string().min(1).max(128).nullable().optional(),
  // Google Ads click identifier — captured from ?gclid= on the landing URL
  // and forwarded with every event in the session. First-touch wins. Length
  // isn't formally documented by Google; ~50 chars is typical, 256 is a safe
  // ceiling. See migration 0014. Not linked to user_id.
  gclid: z.string().min(1).max(256).nullable().optional(),
  // gbraid / wbraid — same handling as gclid, captured from ?gbraid= / ?wbraid=
  // when a plain gclid isn't present (iOS / consent-limited clicks). See
  // migration 0030. A session normally carries at most one of the three.
  gbraid: z.string().min(1).max(256).nullable().optional(),
  wbraid: z.string().min(1).max(256).nullable().optional(),
});

async function parseJson<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

export const eventsRouter = new Hono<AppContext>();

eventsRouter.post('/track', async (c) => {
  const body = await parseJson(c, TrackSchema);

  // Generous cap: 120 events/min/IP. A real user clicking through the editor
  // tops out well below this; anything higher is almost certainly broken.
  await rateLimit(c.env, {
    key: `track:${clientIp(c.req.raw)}`,
    limit: 120,
    windowSec: 60,
  });

  await insertEvent(c.env.DB, {
    kind: body.kind,
    path: body.path,
    ref: body.ref ?? null,
    sessionId: body.sessionId,
    country: c.req.header('CF-IPCountry') ?? null,
    label: body.label ?? null,
    gclid: body.gclid ?? null,
    gbraid: body.gbraid ?? null,
    wbraid: body.wbraid ?? null,
  });

  return c.body(null, 204);
});
