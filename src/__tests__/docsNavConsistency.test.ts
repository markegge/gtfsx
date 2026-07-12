/**
 * Regression guard for docs-navigation drift.
 *
 * A docs page has to be registered in THREE places, and they've drifted
 * apart from each other twice now:
 *   (a) the page itself       — public/docs/<slug>/index.html
 *   (b) the nav manifest      — public/assets/docs/docs-nav.js SECTIONS
 *       (drives the left sidebar rail AND prev/next on every docs page;
 *       a page missing here renders with neither, and fails silently)
 *   (c) the docs index page   — public/docs/index.html (the human-browsable
 *       list of all docs)
 *
 * This test enumerates all three sources directly from disk and asserts the
 * set of slugs is identical across them, so a page added to one and
 * forgotten in another (or a nav/index entry left pointing at a deleted
 * page) fails CI instead of shipping silently.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_DIR = path.join(ROOT, 'public/docs');
const NAV_FILE = path.join(ROOT, 'public/assets/docs/docs-nav.js');
const INDEX_FILE = path.join(ROOT, 'public/docs/index.html');

/** Every real docs page: a directory under public/docs/ with its own index.html. */
function getPageSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const entry of readdirSync(DOCS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // skips index.html, search-index.json
    if (statSync(path.join(DOCS_DIR, entry.name, 'index.html')).isFile()) {
      slugs.add(entry.name);
    }
  }
  return slugs;
}

/** Slugs registered in docs-nav.js's SECTIONS (LEARN entries use /learn/, not /docs/). */
function getNavSlugs(): Set<string> {
  const src = readFileSync(NAV_FILE, 'utf-8');
  const slugs = new Set<string>();
  const re = /path:\s*'\/docs\/([a-z0-9-]+)\/'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) slugs.add(m[1]);
  return slugs;
}

/** Slugs linked from the docs index (dedupes the repeated footer links). */
function getIndexSlugs(): Set<string> {
  const html = readFileSync(INDEX_FILE, 'utf-8');
  const slugs = new Set<string>();
  const re = /href="\/docs\/([a-z0-9-]+)\/"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) slugs.add(m[1]);
  return slugs;
}

describe('docs navigation stays in sync (pages <-> docs-nav.js SECTIONS <-> docs index)', () => {
  it('found a non-trivial number of entries in all three sources', () => {
    // Guards against a broken path/regex silently producing empty sets that
    // would make the equality check below vacuously pass.
    expect(getPageSlugs().size).toBeGreaterThan(20);
    expect(getNavSlugs().size).toBeGreaterThan(20);
    expect(getIndexSlugs().size).toBeGreaterThan(20);
  });

  it('every docs page is in docs-nav.js SECTIONS and linked from the docs index, with no dead links', () => {
    const pages = getPageSlugs();
    const nav = getNavSlugs();
    const index = getIndexSlugs();

    const allSlugs = new Set<string>([...pages, ...nav, ...index]);
    const problems: string[] = [];

    for (const slug of [...allSlugs].sort()) {
      const inPages = pages.has(slug);
      const inNav = nav.has(slug);
      const inIndex = index.has(slug);
      if (inPages && inNav && inIndex) continue;

      const missingFrom: string[] = [];
      if (!inPages) missingFrom.push('public/docs/<slug>/index.html (dead link -- no such page)');
      if (!inNav) missingFrom.push('docs-nav.js SECTIONS');
      if (!inIndex) missingFrom.push('public/docs/index.html');
      problems.push(`"${slug}" is missing from: ${missingFrom.join(', ')}`);
    }

    expect(problems, `Docs navigation drift:\n${problems.join('\n')}`).toEqual([]);
  });
});
