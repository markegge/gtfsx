/**
 * Build a client-side search index for the GTFS·X docs.
 *
 * Scans public/docs/<slug>/index.html and emits public/docs/search-index.json
 * — one entry per page with {url, title, description, headings, text}. The
 * docs hub (public/docs/index.html) fetches this and does ranked client-side
 * search. Runs as part of `npm run build` so the index stays in sync; the
 * committed copy serves the dev server and is the deploy fallback.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(root, 'public', 'docs');

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—',
  '&ndash;': '–', '&nbsp;': ' ', '&hellip;': '…',
};
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m);
const clean = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const first = (re, s) => { const m = s.match(re); return m ? m[1] : ''; };

const entries = [];
for (const slug of readdirSync(docsDir).sort()) {
  const file = join(docsDir, slug, 'index.html');
  let html;
  try {
    if (!statSync(file).isFile()) continue;
    html = readFileSync(file, 'utf8');
  } catch {
    continue; // not a directory with an index.html
  }

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const h1 = clean(
    first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, body)
      .replace(/<span class="tier-badge[^"]*">[\s\S]*?<\/span>/gi, '')
  );
  const titleTag = clean(first(/<title[^>]*>([\s\S]*?)<\/title>/i, html))
    .replace(/\s*[—–-]\s*GTFS.?X\s*$/i, '');
  const title = h1 || titleTag || slug;
  const description = decode(first(/<meta name="description" content="([^"]*)"/i, html));
  const headings = [...body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => clean(m[1])).filter(Boolean);

  const mainHtml = first(/<main[^>]*>([\s\S]*?)<\/main>/i, body) || body;
  let text = clean(mainHtml);
  if (text.length > 1800) text = text.slice(0, 1800);

  entries.push({ url: `/docs/${slug}/`, title, description, headings, text });
}

entries.sort((a, b) => a.title.localeCompare(b.title));
writeFileSync(join(docsDir, 'search-index.json'), JSON.stringify(entries));
console.log(`docs search index: ${entries.length} pages → public/docs/search-index.json`);
