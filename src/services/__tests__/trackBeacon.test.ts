/**
 * Unit tests for src/services/trackBeacon.ts — focused on
 * captureGclidFromUrl() (Google Ads click identifier capture).
 *
 * Runs in the default node test environment with manually stubbed
 * sessionStorage / window / history shims — happy-dom isn't a project
 * dependency and these few primitives are all the module touches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState: ReturnType<typeof vi.fn> };
}

function setUrl(win: FakeWindow, url: string): void {
  // Parse a path+search+hash into the shape expected by captureGclidFromUrl.
  const u = new URL(url, 'http://localhost');
  win.location.pathname = u.pathname;
  win.location.search = u.search;
  win.location.hash = u.hash;
}

function setupDom(): {
  win: FakeWindow;
  store: Map<string, string>;
  restore: () => void;
} {
  const store = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };

  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    // Reflect the new URL onto our fake window so subsequent reads see it.
    setUrl(win, url);
  });

  const win: FakeWindow = {
    location: { pathname: '/', search: '', hash: '' },
    history: { replaceState },
  };

  vi.stubGlobal('sessionStorage', sessionStorageMock);
  vi.stubGlobal('window', win);

  return {
    win,
    store,
    restore: () => {
      vi.unstubAllGlobals();
      vi.resetModules();
    },
  };
}

describe('captureGclidFromUrl', () => {
  let dom: ReturnType<typeof setupDom>;

  beforeEach(() => {
    dom = setupDom();
  });

  afterEach(() => {
    dom.restore();
  });

  it('captures gclid into sessionStorage and strips it from the URL', async () => {
    setUrl(dom.win, '/learn/gtfs-flex/?gclid=abc123');

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();

    expect(dom.store.get('gb_track_gclid')).toBe('abc123');
    // URL was rewritten with no gclid param and no trailing ?.
    expect(dom.win.history.replaceState).toHaveBeenCalledOnce();
    const [, , newUrl] = dom.win.history.replaceState.mock.calls[0];
    expect(newUrl).toBe('/learn/gtfs-flex/');
  });

  it('first-touch wins — does not overwrite an existing gclid', async () => {
    setUrl(dom.win, '/?gclid=first_touch_abc');

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();
    expect(dom.store.get('gb_track_gclid')).toBe('first_touch_abc');

    // Same session, new URL with a different gclid (e.g. user clicks a
    // second ad mid-session, or re-arrives via a different ad). The stored
    // value MUST remain the first.
    setUrl(dom.win, '/pricing?gclid=different_xyz');
    captureGclidFromUrl();
    expect(dom.store.get('gb_track_gclid')).toBe('first_touch_abc');
  });

  it('caps gclid at 256 chars', async () => {
    const long = 'x'.repeat(400);
    setUrl(dom.win, `/?gclid=${long}`);

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();

    const stored = dom.store.get('gb_track_gclid');
    expect(stored).not.toBeUndefined();
    expect(stored!.length).toBe(256);
  });

  it('is a no-op when no gclid is present', async () => {
    setUrl(dom.win, '/?ref=somewhere');

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();

    expect(dom.store.has('gb_track_gclid')).toBe(false);
    expect(dom.win.history.replaceState).not.toHaveBeenCalled();
  });

  it('captures gbraid when there is no gclid (iOS attribution)', async () => {
    setUrl(dom.win, '/planning/?gbraid=GB_abc123');

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();

    expect(dom.store.get('gb_track_gbraid')).toBe('GB_abc123');
    expect(dom.store.has('gb_track_gclid')).toBe(false);
    const [, , newUrl] = dom.win.history.replaceState.mock.calls[0];
    expect(newUrl).toBe('/planning/');
  });

  it('captures wbraid', async () => {
    setUrl(dom.win, '/?wbraid=WB_xyz');

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();

    expect(dom.store.get('gb_track_wbraid')).toBe('WB_xyz');
  });

  it('preserves other query params when stripping gclid', async () => {
    setUrl(dom.win, '/learn/gtfs-flex/?utm_source=newsletter&gclid=abc123&foo=bar');

    const { captureGclidFromUrl } = await import('../trackBeacon');
    captureGclidFromUrl();

    expect(dom.store.get('gb_track_gclid')).toBe('abc123');
    const [, , newUrl] = dom.win.history.replaceState.mock.calls[0];
    // URLSearchParams may reorder, but utm_source / foo must survive and
    // gclid must be gone.
    expect(newUrl).toContain('utm_source=newsletter');
    expect(newUrl).toContain('foo=bar');
    expect(newUrl).not.toContain('gclid');
    expect(newUrl.startsWith('/learn/gtfs-flex/?')).toBe(true);
  });
});
