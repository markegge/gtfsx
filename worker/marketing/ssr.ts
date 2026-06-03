// SSR entry point for the two marketing routes that are otherwise live React
// pages: /pricing (a React PricingPage) and /demo (the editor preloaded with a
// sample feed). Both fall through to the SPA shell, so a JS-less crawler sees
// the homepage's <title>/description/canonical and concludes they're duplicates
// of `/`. We fix that the same way the forum does (worker/forum/dispatcher.ts):
// pull the SPA shell from ASSETS and use HTMLRewriter to inject route-specific
// SEO head tags + a visible, indexable body skeleton. The React bundle still
// loads and hydrates over it; main.tsx removes the [data-prerendered] block on
// mount so users never see it double up with the live UI.

import type { Env } from '../env';

const CACHE_HEADER = 'public, max-age=300, s-maxage=900';

interface MarketingSeo {
  title: string;
  description: string;
  canonicalUrl: string;
  jsonLd: string;
  body: string;
}

function appOrigin(env: Env): string {
  return env.APP_ORIGIN || 'https://www.gtfsx.com';
}

export async function maybeRenderMarketingPage(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  // Match with or without a trailing slash; canonicalize to the slashed form.
  const path = url.pathname.replace(/\/+$/, '') || '/';

  let seo: MarketingSeo | null = null;
  if (path === '/pricing') seo = pricingSeo(env);
  else if (path === '/demo') seo = demoSeo(env);
  if (!seo) return null;

  return buildResponse(env, seo);
}

function pricingSeo(env: Env): MarketingSeo {
  const canonicalUrl = `${appOrigin(env)}/pricing/`;
  // Use SoftwareApplication (not Product) — Product schema triggers Google's
  // Merchant Listings validator, which then flags us for missing physical-
  // merchandise fields (shippingDetails, hasMerchantReturnPolicy, an image
  // on the Product itself). GTFS·X is a SaaS, not a physical product, so the
  // correct rich-result type is SoftwareApplication. The /demo/ page below
  // already uses this type — this brings the pricing page in line.
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'GTFS·X',
    description:
      'Browser-based GTFS feed editor. Editing is free forever; paid plans add managed publishing and analytical tools.',
    brand: { '@type': 'Brand', name: 'GTFS·X' },
    url: canonicalUrl,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    image: `${appOrigin(env)}/gtfsx-mark.svg`,
    // Enterprise is intentionally omitted — it's invoice-only, has no fixed
    // price, and including it as a price-less Offer would re-trigger the
    // "missing price" warning for no marketing value.
    offers: [
      offer('Free', 0, 'Edit and export GTFS feeds at no cost.'),
      offer('Pro', 49, 'Host and publish feeds — stable URLs, rider-facing embeds, Mobility Database submission.'),
      offer('Agency', 299, 'Plan routes and service as a team — route-level coverage, cost, Title VI, scenario comparison, white-label rider site, and GTFS-Realtime Service Alerts.'),
    ],
  });
  const body = `
    <nav class="breadcrumb"><a href="/">GTFS·X</a> › Pricing</nav>
    <h1>GTFS·X Pricing</h1>
    <p class="lede">Free editor, forever. Pro adds managed publishing at a stable URL. Agency adds the full transit-planning suite — demographic coverage, cost estimation, Title VI equity analysis, and scenario comparison — at roughly one-sixth the price of Remix.</p>
    <ul class="tiers">
      <li><strong>Free — $0.</strong> Create, edit, validate, and export GTFS feeds in your browser. Up to 3 saved feeds in the cloud, GTFS ZIP export, GTFS-Flex authoring, a nationwide demand-propensity map, community support.</li>
      <li><strong>Pro — $49/mo.</strong> Host and publish feeds. Up to 10 saved feeds, publish 1 feed to a stable URL, rider-facing embeds + mini-site, Mobility Database submission, named snapshot history.</li>
      <li><strong>Agency — $299/mo.</strong> Plan routes and service as a team. Unlimited saved feeds, route operating cost estimates, demographic coverage, Title VI equity analysis, scenario comparison, GTFS-Realtime Service Alerts authoring, a fully white-labeled rider site, unlimited team members, cross-org membership for consultants. <a href="/planning">See all planning features →</a></li>
      <li><strong>Enterprise — custom.</strong> For state DOTs, RTAP networks, and large consortiums. Custom feed/seat limits, unlimited managed publishing, phone + email support with SLA.</li>
    </ul>
    <p><a href="mailto:hello@gtfsx.com?subject=GTFS%C2%B7X%20%E2%80%94%20Fix%20my%20feed">Fix my feed for me</a> — prefer a done-for-you service? We can build or repair your GTFS feed.</p>
    <h2>How GTFS·X compares</h2>
    <ul>
      <li><a href="/compare/trillium/">vs. Trillium (Optibus)</a> — managed GTFS service vs. self-serve editor.</li>
      <li><a href="/compare/remix/">vs. Remix by Via</a> — network planning suite vs. GTFS-first tool.</li>
      <li><a href="/compare/gtfs-builder-rtap/">vs. National RTAP GTFS Builder</a> — free spreadsheet builder vs. map-based editor.</li>
      <li><a href="/compare/spare-flex-builder/">vs. Spare GTFS-Flex Builder</a> — microtransit-only builder vs. full GTFS + Flex authoring.</li>
    </ul>
    <p><a href="/">Open the editor</a> · <a href="/about/">About GTFS·X</a></p>
  `;
  return {
    title: 'GTFS·X Pricing — Free Editor, Pro Publishing, Agency Planning',
    description:
      'GTFS·X pricing: free editor forever; Pro at $49/mo for hosting and publishing feeds; Agency at $299/mo for the full route-planning suite; Enterprise for DOTs and consortiums.',
    canonicalUrl,
    jsonLd,
    body,
  };
}

function demoSeo(env: Env): MarketingSeo {
  const canonicalUrl = `${appOrigin(env)}/demo/`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'GTFS·X Demo',
    url: canonicalUrl,
    description:
      'Try the GTFS·X editor with a real sample GTFS feed preloaded — explore routes, stops, schedules, fares, and GTFS-Flex zones on an interactive map.',
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  });
  const body = `
    <nav class="breadcrumb"><a href="/">GTFS·X</a> › Demo</nav>
    <h1>GTFS·X Demo</h1>
    <p class="lede">Open the GTFS·X editor with a real sample transit feed already loaded — no signup, no file to find. Explore how routes, stops, schedules, fares, and GTFS-Flex zones come together on an interactive map.</p>
    <p>The demo loads a complete example feed so you can click straight into the timetable grid, route shapes, stop placement, and fare rules without importing anything. When you're ready, import your own GTFS ZIP or start a feed from scratch.</p>
    <p><a href="/demo">Load the demo feed</a> · <a href="/">Open a blank editor</a> · <a href="/docs/quick-start/">Quick-start guide</a></p>
  `;
  return {
    title: 'GTFS·X Demo — Try the Editor with a Sample Feed',
    description:
      'Try the GTFS·X editor with a sample GTFS feed preloaded. Edit routes, stops, schedules, fares, and Flex zones — no signup or installation required.',
    canonicalUrl,
    jsonLd,
    body,
  };
}

function offer(name: string, priceUsd: number | null, description: string) {
  const base = {
    '@type': 'Offer',
    name,
    description,
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
  };
  if (priceUsd === null) return base;
  return { ...base, price: String(priceUsd) };
}

async function buildResponse(env: Env, seo: MarketingSeo): Promise<Response> {
  // Pull the SPA shell from the static-assets binding and mutate it in place.
  const shellReq = new Request(`${appOrigin(env)}/index.html`);
  const shell = await env.ASSETS.fetch(shellReq);
  if (!shell.ok) {
    return new Response(minimalHtml(seo), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(seo.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', seo.description);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute('content', seo.title);
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        el.setAttribute('content', seo.description);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute('content', seo.canonicalUrl);
      },
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', seo.canonicalUrl);
      },
    })
    .on('h1[data-home-only]', {
      // Drop the homepage's visually-hidden SEO H1 — this route has its
      // own page-topic H1 in the injected body and should be the sole H1.
      element(el) {
        el.remove();
      },
    })
    .on('head', {
      element(el) {
        // The homepage shell ships a WebApplication JSON-LD block; append our
        // route-specific one rather than trying to replace it in-stream.
        el.append(
          `<script type="application/ld+json">${seo.jsonLd.replace(/</g, '\\u003c')}</script>`,
          { html: true },
        );
      },
    })
    .on('body', {
      element(el) {
        el.prepend(
          `<div id="marketing-ssr" data-prerendered><style>#marketing-ssr{max-width:760px;margin:24px auto;padding:0 20px;font-family:system-ui,-apple-system,sans-serif;color:#2A1F18;line-height:1.6}#marketing-ssr h1{font-size:2rem;margin:0 0 0.5rem}#marketing-ssr .lede{font-size:1.15rem;color:#6B5A4D}#marketing-ssr nav.breadcrumb{font-size:0.85rem;color:#6B5A4D;margin-bottom:0.5rem}#marketing-ssr ul.tiers{padding-left:1.2rem}#marketing-ssr ul.tiers>li{margin:0.5rem 0}#marketing-ssr a{color:#E07853}</style>${seo.body}</div>`,
          { html: true },
        );
      },
    });

  const transformed = rewriter.transform(shell);
  return new Response(transformed.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': CACHE_HEADER,
    },
  });
}

function minimalHtml(seo: MarketingSeo): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>${escape(seo.title)}</title>
<meta name="description" content="${escape(seo.description)}"/>
<link rel="canonical" href="${escape(seo.canonicalUrl)}"/>
<script type="application/ld+json">${seo.jsonLd.replace(/</g, '\\u003c')}</script>
</head><body>${seo.body}</body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
