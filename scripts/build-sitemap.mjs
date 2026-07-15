// Generates public/sitemap.xml from the actual static pages so it can never go
// stale (it used to be hand-maintained and drifted — missing several /docs/*
// pages). Runs as the first step of `npm run build`.
//
// Inclusion policy, driven by each page's OWN SEO signals (so a new page is in
// the sitemap automatically, and an intentionally-hidden one stays out):
//   • Every public/**/index.html is a candidate.
//   • SKIP if the page is <meta name="robots" ... noindex> (e.g. /embed-demo/).
//   • Emit the page's <link rel="canonical"> URL when present — this collapses
//     /home/ (canonical = /) onto the root and de-dupes naturally; fall back to
//     the directory path when a page has no canonical.
//   • EXTRA_ROUTES covers real, indexable pages served by the Worker/SPA that
//     have no static index.html (kept in sync with worker/index.ts).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(root, 'public');
const SITE = 'https://www.gtfsx.com';

// Worker/SPA-served, indexable routes with no static public/<route>/index.html.
const EXTRA_ROUTES = ['/', '/pricing/', '/demo/', '/help'];

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name === 'index.html') acc.push(p);
  }
  return acc;
}

const isNoindex = (html) =>
  /<meta[^>]*name=["']robots["'][^>]*noindex/i.test(html) ||
  /<meta[^>]*noindex[^>]*name=["']robots["']/i.test(html);

const canonicalOf = (html) => {
  const m = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  return m ? m[1] : null;
};

const locs = new Set(EXTRA_ROUTES.map((r) => SITE + r));

for (const file of walk(PUBLIC)) {
  const html = readFileSync(file, 'utf8');
  if (isNoindex(html)) continue;
  let loc = canonicalOf(html);
  if (!loc) {
    const rel = relative(PUBLIC, dirname(file)).replace(/\\/g, '/');
    loc = SITE + (rel ? `/${rel}/` : '/');
  }
  // Normalize host: accept apex OR www, http OR https, and always emit the
  // canonical www host (one page — /feed-health/ — canonicals to the apex).
  loc = loc.replace(/^https?:\/\/(www\.)?gtfsx\.com/i, SITE);
  if (loc.startsWith(SITE)) locs.add(loc);
}

const urls = [...locs].sort((a, b) => a.localeCompare(b));
const body = urls
  .map((u) => `  <url>\n    <loc>${u}</loc>\n  </url>`)
  .join('\n');
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

writeFileSync(resolve(PUBLIC, 'sitemap.xml'), xml);
console.log(`[sitemap] wrote public/sitemap.xml with ${urls.length} URLs`);
