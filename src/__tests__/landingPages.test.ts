/**
 * Static landing-page sanity tests for bundle 8 (campaign LP at
 * /lp/gtfs-editor/).
 *
 * These are pure file-content assertions — the LPs are static HTML served
 * directly from `public/` (no SSR overlay), so we don't need a worker
 * round-trip. We check the bits that are easy to break and expensive to
 * miss: the JSON-LD shape (SoftwareApplication + BreadcrumbList + FAQPage,
 * no Product), the CTA tracking labels, the self-hosted video tag with
 * preload="metadata", and the inline gclid/cta_click beacon. Anything more
 * (visual layout, PageSpeed) is left to the manual mobile-audit step in
 * the PR description.
 *
 * The agency-planning campaign LP (formerly /lp/agency-planning/) was merged
 * into the /planning marketing page — its Google Ads now land on /planning and
 * the LP file was deleted. The conversion content it carried (the
 * GTFS·X-vs-Remix comparison table and the FAQ) now lives on /planning; the
 * final describe block asserts that content survived the port.
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

const PAGES = [
  {
    label: 'editor LP',
    file: 'public/lp/gtfs-editor/index.html',
    canonical: 'https://www.gtfsx.com/lp/gtfs-editor/',
    primaryCtaLabel: 'lp_editor_primary_cta',
    primaryCtaHref: 'https://www.gtfsx.com/',
    videoSrc: 'https://videos.gtfsx.com/lp-editor-demo.mp4',
    softwareName: 'GTFS·X',
    faqFirstQuestion: 'Is it really free?',
    breadcrumbLeaf: 'GTFS Editor',
  },
] as const;

for (const p of PAGES) {
  describe(`${p.label} (${p.file})`, () => {
    it('renders with canonical, single H1, and og tags', async () => {
      const html = await loadPage(p.file);
      expect(html).toContain(`<link rel="canonical" href="${p.canonical}"`);
      expect(html).toContain('<meta property="og:image"');

      // Single visible H1 (the only one in the document body — no SEO duplicate).
      const h1Count = (html.match(/<h1\b/g) ?? []).length;
      expect(h1Count).toBe(1);
    });

    it('emits SoftwareApplication + BreadcrumbList + FAQPage JSON-LD (and NOT Product)', async () => {
      const html = await loadPage(p.file);
      const blocks = parseJsonLdBlocks(html);
      const types = blocks.map(jsonLdType);
      expect(types).toContain('SoftwareApplication');
      expect(types).toContain('BreadcrumbList');
      expect(types).toContain('FAQPage');
      // Product schema is deliberately avoided — Search Console fix shipped
      // May 2026 (commit 1298f4d) keeps us on SoftwareApplication so the
      // Merchant Listings validator doesn't ask for physical-goods fields.
      expect(types).not.toContain('Product');
      expect(html).not.toMatch(/"@type"\s*:\s*"Product"/);

      // SoftwareApplication has the canonical name + an Offer.
      const sa = blocks.find((b) => jsonLdType(b) === 'SoftwareApplication') as {
        name: string; offers: Array<{ '@type': string }>;
      };
      expect(sa.name).toBe(p.softwareName);
      expect(sa.offers.length).toBeGreaterThan(0);

      // BreadcrumbList ends at the right leaf.
      const bc = blocks.find((b) => jsonLdType(b) === 'BreadcrumbList') as {
        itemListElement: Array<{ name: string; position: number }>;
      };
      const leaf = bc.itemListElement[bc.itemListElement.length - 1];
      expect(leaf.name).toBe(p.breadcrumbLeaf);

      // FAQPage has 6 Q&A pairs and the first one matches the handoff copy.
      const faq = blocks.find((b) => jsonLdType(b) === 'FAQPage') as {
        mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
      };
      expect(faq.mainEntity).toHaveLength(6);
      expect(faq.mainEntity[0].name).toBe(p.faqFirstQuestion);
    });

    it('primary CTA carries the correct data-cta label and href', async () => {
      const html = await loadPage(p.file);
      const ctaRegex = new RegExp(
        `data-cta=["']${p.primaryCtaLabel}["']`,
        'g',
      );
      const matches = html.match(ctaRegex) ?? [];
      // Header CTA + hero CTA + secondary CTA + sticky-mobile CTA = 4.
      expect(matches.length).toBeGreaterThanOrEqual(3);
      // The hero href is the campaign destination.
      expect(html).toContain(`href="${p.primaryCtaHref}"`);
    });

    it('embeds a self-hosted MP4 with preload=metadata and a poster (no YouTube iframe)', async () => {
      const html = await loadPage(p.file);
      expect(html).toContain(`<source src="${p.videoSrc}"`);
      expect(html).toContain('preload="metadata"');
      expect(html).toContain('poster="/assets/docs/');
      expect(html).not.toContain('youtube.com/embed');
      expect(html).not.toContain('youtube-nocookie.com');
      expect(html).not.toContain('player.vimeo.com');
    });

    it('inlines a cookieless analytics beacon (page_view + cta_click + gclid/ref capture)', async () => {
      const html = await loadPage(p.file);
      // Same sessionStorage keys as src/services/trackBeacon.ts.
      expect(html).toContain("'gb_track_session'");
      expect(html).toContain("'gb_track_ref'");
      expect(html).toContain("'gb_track_gclid'");
      // Captures the URL params bundle 6 cares about (first-touch wins).
      expect(html).toMatch(/capture\(['"]ref['"]/);
      expect(html).toMatch(/capture\(['"]gclid['"]/);
      // POSTs to the existing /api/events/track endpoint.
      expect(html).toContain("'/api/events/track'");
      // Fires the two kinds.
      expect(html).toContain("send('page_view'");
      expect(html).toContain("send('cta_click'");
      // No third-party analytics libraries.
      expect(html).not.toMatch(/googletagmanager\.com|google-analytics\.com|gtag\(/);
    });
  });
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
    'public/lp/gtfs-editor/index.html',
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
    expect(html).toContain('or subscribe — $2,988/yr');
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
    // Trial survives as the secondary CTA with its existing anchor.
    expect(html).toContain('href="/pricing/#agency"');
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
