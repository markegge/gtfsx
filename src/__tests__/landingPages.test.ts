/**
 * Static marketing-page sanity tests (pure file-content assertions — the
 * pages are static HTML served directly from `public/`, no SSR overlay, so
 * no worker round-trip is needed).
 *
 * Both dedicated campaign LPs are retired:
 * - /lp/agency-planning/ was merged into the /planning marketing page (its
 *   Google Ads land on /planning; the comparison table + FAQ it carried are
 *   asserted below to have survived the port).
 * - /lp/gtfs-editor/ was retired in pricing v4 (2026-07): with no paid
 *   editor tier left to upsell, the homepage's editor hero panel does the
 *   same job. The editor ads land on / and the path 301s there.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadPage(rel: string): Promise<string> {
  return await readFile(path.join(ROOT, rel), 'utf-8');
}

function parseJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    blocks.push(JSON.parse(m[1].trim()));
  }
  return blocks;
}

function jsonLdType(block: unknown): string | null {
  if (block && typeof block === 'object' && '@type' in block) {
    const v = (block as { '@type': unknown })['@type'];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

describe('/planning — ported comparison table + FAQ (from the retired agency LP)', () => {
  it('renders the GTFS·X $2,988 comparison in both the desktop table and mobile cards', async () => {
    const html = await loadPage('public/planning/index.html');
    expect(html).toMatch(/\$2,988/);
    // Cards stack to a single column < 640px, so the markup must contain a
    // .compare-cards container alongside the .compare-table.
    expect(html).toContain('compare-table');
    expect(html).toContain('compare-cards');
    // The price positioning links out to the honest side-by-side comparisons.
    expect(html).toContain('/compare/remix/');
  });

  it('keeps the FAQ (visible <details> + matching FAQPage JSON-LD)', async () => {
    const html = await loadPage('public/planning/index.html');
    const blocks = parseJsonLdBlocks(html);
    const faq = blocks.find((b) => jsonLdType(b) === 'FAQPage') as
      | { mainEntity: Array<{ name: string }> }
      | undefined;
    expect(faq).toBeDefined();
    expect(faq!.mainEntity.length).toBeGreaterThanOrEqual(6);
    // The Remix comparison question is the lead FAQ entry, visible and in JSON-LD.
    expect(html).toContain('How does GTFS·X Planner compare to Remix?');
    expect(faq!.mainEntity[0].name).toBe('How does GTFS·X Planner compare to Remix?');
  });

  it('points the demo video caption track at the moved /planning/captions.vtt', async () => {
    const html = await loadPage('public/planning/index.html');
    expect(html).toContain('src="/planning/captions.vtt"');
    expect(html).not.toContain('/lp/agency-planning/captions.vtt');
  });
});

describe('Editor / Planner / Enterprise lineup (2026-07 pricing overhaul)', () => {
  const MARKETING_PAGES = [
    'public/home/index.html',
    'public/planning/index.html',
    'public/docs/pricing/index.html',
    'public/compare/remix/index.html',
    'public/compare/trillium/index.html',
    'public/compare/spare-flex-builder/index.html',
    'public/compare/gtfs-builder-rtap/index.html',
    'public/use-cases/state-dot/index.html',
    'public/about/index.html',
  ];

  it('carries no leftover Pro-tier / $49 pricing on any marketing page', async () => {
    for (const page of MARKETING_PAGES) {
      const html = await loadPage(page);
      expect(html, page).not.toMatch(/\$49\b/);
      expect(html, page).not.toMatch(/\$199\b/);
      expect(html, page).not.toMatch(/\$2,888/);
      expect(html, page).not.toMatch(/Pro tier|Team tier|Agency tier/);
      expect(html, page).not.toContain('fantastical.app');
    }
  });

  it('home: two-panel hero with a single H1, editor CTA, and Planner demo CTA', async () => {
    const html = await loadPage('public/home/index.html');
    const h1Count = (html.match(/<h1\b/g) ?? []).length;
    expect(h1Count).toBe(1);
    // Left panel keeps the existing editor CTA target/behavior.
    expect(html).toMatch(/href="\/editor"[^>]*data-cta="open-editor"/);
    // Right panel: demo-first, subscribe as the secondary text link.
    expect(html).toContain('href="/book-demo?src=home_panel"');
    expect(html).toContain('Book a 30-min demo');
    expect(html).toContain('or subscribe · $2,988/yr');
    // Pricing teaser: 3 cards, Planner is the featured one.
    expect(html).toContain('href="/book-demo?src=home_pricing"');
    expect(html).toContain('href="/book-demo?src=home_enterprise"');
    expect(html).toMatch(/<div class="pname">Editor<\/div>/);
    expect(html).toMatch(/<div class="pname">Planner<\/div>/);
    expect(html).toMatch(/<div class="pname">Enterprise<\/div>/);
    expect(html).toContain('Multi-agency subscriptions for consultants and state DOTs');
  });

  it('home: inlines the cookieless beacon with gclid capture + /book-demo carry-through', async () => {
    const html = await loadPage('public/home/index.html');
    expect(html).toContain("'gb_track_gclid'");
    expect(html).toMatch(/capture\(['"]gclid['"]/);
    expect(html).toContain("'/api/events/track'");
    expect(html).toContain("indexOf('/book-demo')");
    expect(html).not.toMatch(/googletagmanager\.com|google-analytics\.com|gtag\(/);
  });

  it('planning: demo-first CTAs at every placement, trial demoted to secondary', async () => {
    const html = await loadPage('public/planning/index.html');
    for (const src of ['planning_hero', 'planning_footer', 'planning_header', 'planning_sticky']) {
      expect(html).toContain(`href="/book-demo?src=${src}"`);
    }
    // Trial survives as the secondary CTA, deep-linking straight into the
    // agency-trial checkout (auto-fires once signed in) rather than the old
    // pricing-page anchor.
    expect(html).toContain('href="/pricing?plan=agency&amp;interval=year"');
    expect(html).toContain('or start a 14-day free trial');
    // Planner is qualified on first mention (never a rider trip-planner).
    expect(html).toContain('the service-planning suite for transit agencies');
    // JSON-LD Offer renamed to Planner, price unchanged.
    const blocks = parseJsonLdBlocks(html);
    const sa = blocks.find((b) => jsonLdType(b) === 'SoftwareApplication') as {
      offers: Array<{ name: string; price: string }>;
    };
    expect(sa.offers[0].name).toBe('Planner');
    expect(sa.offers[0].price).toBe('2988');
    // gclid carry-through onto /book-demo links.
    expect(html).toContain("indexOf('/book-demo')");
  });

  it('planning: keeps the Remix cost comparison and P-card framing', async () => {
    const html = await loadPage('public/planning/index.html');
    expect(html).toContain('GTFS·X Planner');
    expect(html).toMatch(/\$2,988/);
    expect(html).toContain('micro-purchase threshold');
  });

  it('docs/pricing: three plans with the new entitlement placement', async () => {
    const html = await loadPage('public/docs/pricing/index.html');
    expect(html).toContain('Editor (free)');
    expect(html).toMatch(/\$299\/mo/);
    expect(html).toMatch(/\$2,988\/yr/);
    expect(html).toContain('multi-agency subscriptions for consultants and state DOTs');
    expect(html).not.toMatch(/col-pro\b/);
    // GeoJSON export is free now; propensity stays free.
    expect(html).toContain('GeoJSON export');
  });
});
