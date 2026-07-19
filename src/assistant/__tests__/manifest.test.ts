// Load-bearing drift guard for the "Ask GTFS·X" capabilities manifest (issue #68).
// Keeps the hand-curated manifest honest: every deepLink target must be a real
// SidebarSection / BottomPanelTab, every docs url must exist in the docs search
// index, and every plan must be 'all' or a real FeatureKey. If this fails, the
// assistant would propose click-paths / cite docs that don't exist.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIDEBAR_SECTIONS, BOTTOM_PANEL_TABS } from '../deepLinkTargets';
import { FEATURE_PLANS } from '../../components/billing/planConfig';

interface Capability {
  id: string;
  name: string;
  category: string;
  purpose: string;
  whenToUse: string;
  clickPath: string;
  deepLink?: { sidebarSection?: string; bottomTab?: string } | null;
  plan: string;
  docs?: string[];
  limitations?: string;
}
interface NotSupported {
  ask: string;
  reason: string;
  workaround?: string | null;
}
interface Manifest {
  capabilities: Capability[];
  notSupported: NotSupported[];
}

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'assistant/manifest.json'), 'utf8')) as Manifest;
const docsIndex = JSON.parse(readFileSync(join(root, 'public/docs/search-index.json'), 'utf8')) as { url: string }[];

const docUrls = new Set(docsIndex.map((d) => d.url));
const sidebarSet = new Set<string>(SIDEBAR_SECTIONS);
const bottomSet = new Set<string>(BOTTOM_PANEL_TABS);
const featureKeys = new Set<string>(Object.keys(FEATURE_PLANS));
const validPlans = new Set<string>(['all', ...featureKeys]);

describe('assistant capabilities manifest', () => {
  it('has capabilities and notSupported entries', () => {
    expect(manifest.capabilities.length).toBeGreaterThan(20);
    expect(manifest.notSupported.length).toBeGreaterThan(0);
  });

  it('every capability id is unique', () => {
    const ids = manifest.capabilities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every capability has the required fields', () => {
    for (const c of manifest.capabilities) {
      for (const f of ['id', 'name', 'category', 'purpose', 'whenToUse', 'clickPath', 'plan'] as const) {
        expect(typeof c[f], `${c.id}.${f}`).toBe('string');
        expect((c[f] as string).length, `${c.id}.${f} non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every deepLink target is a real SidebarSection or BottomPanelTab', () => {
    for (const c of manifest.capabilities) {
      const dl = c.deepLink;
      if (!dl) continue;
      if (dl.sidebarSection !== undefined) {
        expect(sidebarSet.has(dl.sidebarSection), `${c.id} → sidebarSection ${dl.sidebarSection}`).toBe(true);
      }
      if (dl.bottomTab !== undefined) {
        expect(bottomSet.has(dl.bottomTab), `${c.id} → bottomTab ${dl.bottomTab}`).toBe(true);
      }
      // A deepLink must carry exactly one kind of target.
      const kinds = [dl.sidebarSection, dl.bottomTab].filter((v) => v !== undefined);
      expect(kinds.length, `${c.id} deepLink has one target`).toBe(1);
    }
  });

  it('every docs url exists in the docs search index', () => {
    for (const c of manifest.capabilities) {
      for (const u of c.docs ?? []) {
        expect(docUrls.has(u), `${c.id} docs url ${u}`).toBe(true);
      }
    }
  });

  it('every plan is "all" or a real FeatureKey', () => {
    for (const c of manifest.capabilities) {
      expect(validPlans.has(c.plan), `${c.id} plan ${c.plan}`).toBe(true);
    }
  });

  it('every notSupported entry is well-formed', () => {
    for (const n of manifest.notSupported) {
      expect(typeof n.ask).toBe('string');
      expect(n.ask.length).toBeGreaterThan(0);
      expect(typeof n.reason).toBe('string');
      expect(n.reason.length).toBeGreaterThan(0);
      expect(n.workaround === null || typeof n.workaround === 'string').toBe(true);
    }
  });
});
