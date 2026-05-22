// One-time: add TechArticle JSON-LD to every /docs/* sub-page and WebPage
// JSON-LD to /privacy-policy/. The /docs/ index already has its own simpler
// schema and is left alone. Per-page values (headline, description,
// mainEntityOfPage) are extracted from each file's existing head meta so the
// schema can't drift from the visible title/description.
//
//   node scripts/add-techarticle-jsonld.mjs
//
// Idempotent: skips any file that already has an application/ld+json block.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, relative } from 'node:path';
import { globSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DATE_PUBLISHED = '2026-05-01';
const DATE_MODIFIED = '2026-05-22';

// All /docs/<sub>/index.html — except /docs/index.html (already has schema).
const docPages = globSync('public/docs/*/index.html', { cwd: root })
  .map((p) => ({ rel: p, type: 'TechArticle' }));
docPages.push({ rel: 'public/privacy-policy/index.html', type: 'WebPage' });

function extractMeta(html) {
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim();
  const description = html.match(
    /<meta name="description" content="([^"]+)"\s*\/?>/,
  )?.[1];
  const canonical = html.match(
    /<link rel="canonical" href="([^"]+)"\s*\/?>/,
  )?.[1];
  return { title, description, canonical };
}

function buildJsonLd(type, { title, description, canonical }) {
  // HTML-escape `<` so the script body can't terminate the surrounding
  // <script> element if a future description ever contains "</".
  const obj = {
    '@context': 'https://schema.org',
    '@type': type,
    headline: title,
    description,
    image: 'https://www.gtfsx.com/og-default.png',
    author: {
      '@type': 'Organization',
      name: 'GTFS·X',
      url: 'https://www.gtfsx.com/',
    },
    publisher: {
      '@type': 'Organization',
      name: 'GTFS·X',
      logo: {
        '@type': 'ImageObject',
        url: 'https://www.gtfsx.com/gtfsx-lockup.svg',
      },
    },
    datePublished: DATE_PUBLISHED,
    dateModified: DATE_MODIFIED,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonical,
    },
  };
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

let changed = 0;
let skipped = 0;
let failed = 0;
for (const { rel, type } of docPages) {
  const file = resolve(root, rel);
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    console.warn(`MISSING: ${rel}`);
    failed++;
    continue;
  }
  if (html.includes('application/ld+json')) {
    skipped++;
    continue;
  }
  const meta = extractMeta(html);
  if (!meta.title || !meta.description || !meta.canonical) {
    console.warn(`MISSING META: ${rel}`, meta);
    failed++;
    continue;
  }
  const jsonLd = buildJsonLd(type, meta);
  // Insert just before </head> using its leading indentation. Every page in
  // this set indents </head> with 2 spaces, but match whatever's there.
  const re = /([ \t]*)<\/head>/;
  const m = html.match(re);
  if (!m) {
    console.warn(`NO </head>: ${rel}`);
    failed++;
    continue;
  }
  const indent = m[1];
  const block =
    `${indent}<script type="application/ld+json">\n` +
    `${jsonLd}\n` +
    `${indent}</script>\n${indent}</head>`;
  html = html.replace(re, block);
  writeFileSync(file, html);
  console.log(`added ${type}: ${rel}`);
  changed++;
}
console.log(`\n${changed} added · ${skipped} already had schema · ${failed} failed.`);
