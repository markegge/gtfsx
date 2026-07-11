// GET /book-demo — demo-booking funnel entry point.
//
// Every marketing placement links here as /book-demo?src=<placement> (plus
// ?gclid=... when the click came from a Google Ad). We record a first-party
// `demo_request` conversion event in D1, then 302 to the founder's booking
// page. The event row follows the same cookieless conventions as
// /api/events/track — no IP, no User-Agent, no user id stored (see
// worker/events/insert.ts); `src` lands in `label`, the Referer in `ref`.
//
// gclid-stamped demo_request rows are uploaded to Google Ads by the daily
// OCI cron — see worker/marketing/ads/oci.ts.
//
// The redirect must NEVER fail: the event insert is wrapped in try/catch and
// errors are logged and swallowed. Obvious bots/crawlers are redirected
// without logging so the conversion counts stay clean.

import type { Env } from '../env';
import { insertEvent } from '../events/insert';
import { errorDetail } from '../util/redact';

// ─── Booking destination ────────────────────────────────────────────────────
// The ONE place the booking URL lives: Mark's dedicated Fantastical
// demo-booking page. If the destination ever changes, update only this
// constant (and the Location assertion in marketing.bookDemo.test.ts).
export const DEMO_BOOKING_URL = 'https://fantastical.app/markegge/gtfsx-demo';

// Obvious bot/crawler User-Agent fragments, matched case-insensitively.
// Deliberately small: this is hygiene, not security — we only want the
// loudest crawlers and scripted fetches out of the conversion counts. (No
// shared bot-detection helper exists in the repo; the SSR layer serves bots
// the same HTML as everyone else, so this list lives here.) 'bot' alone
// covers Googlebot, bingbot, AhrefsBot, Slackbot, Discordbot, Twitterbot, …
const BOT_UA_FRAGMENTS = [
  'bot',
  'crawler',
  'spider',
  'slurp',
  'headlesschrome',
  'facebookexternalhit',
  'python-requests',
  'python-urllib',
  'curl/',
  'wget/',
];

export function isLikelyBot(userAgent: string | null): boolean {
  // Real browsers always send a User-Agent; a missing one means a script.
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  return BOT_UA_FRAGMENTS.some((f) => ua.includes(f));
}

// Trim + cap, empty → null. Caps mirror the TrackSchema limits in
// worker/events/routes.ts (label ≤128, gclid ≤256, ref ≤128).
function cleanParam(value: string | null, maxLen: number): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : null;
}

// `event.session_id` is NOT NULL and there's no client beacon session on a
// plain link click — mint a random id per event, same shape as the client's
// (16 bytes of entropy as hex; see src/services/trackBeacon.ts).
function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleBookDemo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const src = cleanParam(url.searchParams.get('src'), 128); // placement label
  const gclid = cleanParam(url.searchParams.get('gclid'), 256);

  if (!isLikelyBot(request.headers.get('User-Agent'))) {
    try {
      await insertEvent(env.DB, {
        kind: 'demo_request',
        path: '/book-demo',
        ref: cleanParam(request.headers.get('Referer'), 128),
        sessionId: randomSessionId(),
        country: request.headers.get('CF-IPCountry') ?? null,
        label: src,
        gclid,
      });
    } catch (err) {
      // Analytics must never block the booking redirect.
      console.error(`[book-demo] event insert failed: ${errorDetail(err)}`);
    }
  }

  return Response.redirect(DEMO_BOOKING_URL, 302);
}
