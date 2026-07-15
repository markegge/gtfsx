// GET /book-demo — demo-request lead form.
//
// Every marketing placement links here as /book-demo?src=<placement> (plus
// ?gclid=... when the click came from a Google Ad). This used to 302 straight
// to the founder's booking calendar and record the `demo_request` conversion
// on the redirect. It now serves a short lead form instead: we capture the
// visitor's contact details first (POST /api/demo-leads — see
// worker/marketing/demoLead.ts), THEN offer the same calendar on the
// thank-you state. The Google Ads `demo_request` conversion moved with it and
// now fires on the form submit, so this GET writes NO event (for anyone,
// bots included) — it only renders the page.
//
// The page is worker-rendered (not a static asset / SPA route) so it keeps
// serving on this exact URL with the query string intact for the client to
// forward on submit. See worker/marketing/bookDemoPage.ts for the markup.

import type { Env } from '../env';
import { renderBookDemoPage } from './bookDemoPage';

// ─── Booking destination ────────────────────────────────────────────────────
// The ONE place the booking URL lives: Mark's dedicated Fantastical
// demo-booking page. Referenced by the page renderer (the "skip ahead" link and
// the thank-you "Grab a time now" button). If it ever changes, update only this
// constant (and the Location assertion in marketing.bookDemo.test.ts).
export const DEMO_BOOKING_URL = 'https://fantastical.app/markegge/gtfsx-demo';

export async function handleBookDemo(_request: Request, env: Env): Promise<Response> {
  const html = renderBookDemoPage({
    siteKey: env.TURNSTILE_SITE_KEY ?? '',
    bookingUrl: DEMO_BOOKING_URL,
  });
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Not a content page — keep it out of the index. Also don't cache: the
      // rendered site key comes from env and shouldn't be pinned by a CDN.
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
    },
  });
}
