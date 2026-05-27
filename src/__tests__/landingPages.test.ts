/**
 * Static landing-page sanity tests for bundle 8 (campaign LPs at
 * /lp/gtfs-editor/ and /lp/agency-planning/).
 *
 * These are pure file-content assertions — the LPs are static HTML served
 * directly from `public/` (no SSR overlay), so we don't need a worker
 * round-trip. We check the bits that are easy to break and expensive to
 * miss: the JSON-LD shape (SoftwareApplication + BreadcrumbList + FAQPage,
 * no Product), the CTA tracking labels, the self-hosted video tag with
 * preload="metadata", and the inline gclid/cta_click beacon. Anything more
 * (visual layout, PageSpeed) is left to the manual mobile-audit step in
 * the PR description.
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
  {
    label: 'agency LP',
    file: 'public/lp/agency-planning/index.html',
    canonical: 'https://www.gtfsx.com/lp/agency-planning/',
    primaryCtaLabel: 'lp_agency_primary_cta',
    primaryCtaHref: 'https://www.gtfsx.com/pricing/#agency',
    videoSrc: 'https://videos.gtfsx.com/lp-agency-demo.mp4',
    softwareName: 'GTFS·X Agency',
    faqFirstQuestion: 'How does GTFS·X Agency compare to Remix?',
    breadcrumbLeaf: 'Agency Planning',
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

describe('agency LP — Remix-compare secondary CTA', () => {
  it('has the lp_agency_compare_remix label on the Compare-to-Remix link', async () => {
    const html = await loadPage('public/lp/agency-planning/index.html');
    expect(html).toMatch(/data-cta=["']lp_agency_compare_remix["'][^>]*href=["']\/compare\/remix\/["']|href=["']\/compare\/remix\/["'][^>]*data-cta=["']lp_agency_compare_remix["']/);
  });
});

describe('agency LP — pricing comparison renders both desktop table and mobile cards', () => {
  it('has the GTFS·X $2,499 price prominently in both layouts', async () => {
    const html = await loadPage('public/lp/agency-planning/index.html');
    expect(html).toMatch(/\$2,499/);
    // Cards stack to single column < 640px — markup must contain a .compare-cards
    // container alongside the .compare-table.
    expect(html).toContain('compare-table');
    expect(html).toContain('compare-cards');
  });
});
