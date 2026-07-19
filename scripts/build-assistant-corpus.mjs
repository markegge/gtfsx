/**
 * Bundle the "Ask GTFS·X" grounding corpus (issue #68).
 *
 * Reads:
 *   - public/docs/search-index.json  (built by build-docs-search-index.mjs — run that FIRST)
 *   - public/learn/<slug>/index.html (the 3 learn articles)
 *   - assistant/manifest.json        (hand-curated capabilities + notSupported)
 * Writes:
 *   - worker/assistant/corpus.generated.json  (imported by the worker at build/bundle time)
 *
 * Wired into `npm run build` after build-docs-search-index. The committed output
 * serves dev, tests, and tsc (which type-check the worker's JSON import), the same
 * way the committed search-index.json serves as a dev/deploy fallback.
 *
 * Also does a build-time sanity check: every capability deepLink target must be a
 * real SidebarSection / BottomPanelTab id and every docs url must exist in the
 * index. The load-bearing guard is src/assistant/__tests__/manifest.test.ts (which
 * validates against the actual TS unions); this is a fast fail-early copy.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Keep in sync with src/types/ui.ts (SidebarSection) and (BottomPanelTab). The
// vitest drift test validates against the real unions; this is the fast copy.
const SIDEBAR_SECTIONS = new Set([
  'agency', 'calendar', 'routes', 'stops', 'stations', 'frequencies', 'blocks',
  'fares', 'flex', 'costs', 'coverage', 'titlevi', 'stop-analysis',
  'access-isochrones', 'alerts', 'variants', 'settings',
]);
const BOTTOM_PANEL_TABS = new Set([
  'timetable', 'blocks', 'service-summary', 'validation', 'snapshots', 'publish',
  'embed', 'audit',
]);

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—',
  '&ndash;': '–', '&nbsp;': ' ', '&hellip;': '…',
};
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m);
const clean = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const first = (re, s) => { const m = s.match(re); return m ? m[1] : ''; };

// ── Docs ────────────────────────────────────────────────────────────────────
const docsIndexPath = join(root, 'public', 'docs', 'search-index.json');
const docs = JSON.parse(readFileSync(docsIndexPath, 'utf8'));
const docUrls = new Set(docs.map((d) => d.url));

// ── Learn articles ────────────────────────────────────────────────────────────
const learnDir = join(root, 'public', 'learn');
const learn = [];
for (const slug of readdirSync(learnDir).sort()) {
  const file = join(learnDir, slug, 'index.html');
  let html;
  try {
    if (!statSync(file).isFile()) continue;
    html = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const h1 = clean(first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, body));
  const titleTag = clean(first(/<title[^>]*>([\s\S]*?)<\/title>/i, html)).replace(/\s*[—–-]\s*GTFS.?X\s*$/i, '');
  const title = h1 || titleTag || slug;
  const mainHtml = first(/<main[^>]*>([\s\S]*?)<\/main>/i, body) || body;
  let text = clean(mainHtml);
  if (text.length > 1800) text = text.slice(0, 1800);
  learn.push({ url: `/learn/${slug}/`, title, text });
}

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(root, 'assistant', 'manifest.json'), 'utf8'));

// ── Validate ──────────────────────────────────────────────────────────────────
const errors = [];
for (const cap of manifest.capabilities) {
  const dl = cap.deepLink;
  if (dl && dl.sidebarSection && !SIDEBAR_SECTIONS.has(dl.sidebarSection)) {
    errors.push(`capability ${cap.id}: unknown sidebarSection "${dl.sidebarSection}"`);
  }
  if (dl && dl.bottomTab && !BOTTOM_PANEL_TABS.has(dl.bottomTab)) {
    errors.push(`capability ${cap.id}: unknown bottomTab "${dl.bottomTab}"`);
  }
  for (const u of cap.docs ?? []) {
    if (!docUrls.has(u)) errors.push(`capability ${cap.id}: docs url not in index: ${u}`);
  }
}
if (errors.length) {
  console.error('assistant corpus validation FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}

// ── Write ─────────────────────────────────────────────────────────────────────
const corpus = {
  generatedAt: new Date().toISOString().slice(0, 10),
  docs,
  learn,
  capabilities: manifest.capabilities,
  notSupported: manifest.notSupported,
};
const outPath = join(root, 'worker', 'assistant', 'corpus.generated.json');
writeFileSync(outPath, JSON.stringify(corpus));
console.log(
  `assistant corpus: ${docs.length} docs + ${learn.length} learn + ${manifest.capabilities.length} capabilities + ${manifest.notSupported.length} notSupported → worker/assistant/corpus.generated.json`,
);
