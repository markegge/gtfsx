/**
 * Unit tests for src/services/proIntent.ts — the in-app upgrade-nudge gating +
 * pro-intent instrumentation (Part B of warm-cohort-export-and-upgrade-nudges).
 *
 * Runs in the default node test environment with manually stubbed localStorage
 * and fetch (no jsdom in this project; these few primitives are all the module
 * touches), mirroring services/__tests__/trackBeacon.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordProIntent,
  fireProNudge,
  shouldShowUpgradeEntry,
  isFreePlan,
  hasNudgeFired,
  nudgeStorageKey,
} from '../proIntent';
import type { Plan } from '../billingApi';

function makeStorageMock() {
  const store = new Map<string, string>();
  return {
    store,
    mock: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  };
}

let storage: ReturnType<typeof makeStorageMock>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = makeStorageMock();
  fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal('localStorage', storage.mock);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Read the parsed JSON body + headers of the Nth fetch call (default: last).
function call(n = fetchMock.mock.calls.length - 1) {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as { action: string; source?: string },
  };
}

const FREE = { loggedIn: true, plan: 'free' as Plan };

describe('recordProIntent', () => {
  it('POSTs to /api/me/pro-intent with the exact Part-A contract', () => {
    recordProIntent('publish_intent', 'export_zip');

    expect(fetchMock).toHaveBeenCalledOnce();
    const c = call();
    expect(c.url).toBe('/api/me/pro-intent');
    expect(c.init.method).toBe('POST');
    expect(c.headers['X-GB-Client']).toBe('web');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.init.credentials).toBe('include');
    expect(c.init.keepalive).toBe(true);
    expect(c.body).toEqual({ action: 'publish_intent', source: 'export_zip' });
  });

  it('omits source from the body when not provided', () => {
    recordProIntent('feed_cap');
    expect(call().body).toEqual({ action: 'feed_cap' });
  });

  it('never throws when fetch rejects (silent best-effort)', () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    expect(() => recordProIntent('mini_site')).not.toThrow();
  });
});

describe('fireProNudge — shows once per trigger, then stays dismissed', () => {
  it('fires once for a logged-in free user, marks localStorage, and dedupes', () => {
    const first = fireProNudge({ ...FREE, action: 'mini_site', source: 'embed_tab' });
    expect(first).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call().body).toEqual({ action: 'mini_site', source: 'embed_tab' });
    // Dismissal is persisted in localStorage keyed per-trigger.
    expect(hasNudgeFired('mini_site')).toBe(true);
    expect(storage.store.get(nudgeStorageKey('mini_site'))).toBeDefined();

    // Second attempt for the same trigger: no toast (returns false), no 2nd POST.
    const second = fireProNudge({ ...FREE, action: 'mini_site', source: 'embed_tab' });
    expect(second).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes each of the three triggers independently', () => {
    expect(fireProNudge({ ...FREE, action: 'publish_intent' })).toBe(true);
    expect(fireProNudge({ ...FREE, action: 'feed_cap' })).toBe(true);
    expect(fireProNudge({ ...FREE, action: 'mini_site' })).toBe(true);
    // Re-firing any already-shown trigger is a no-op.
    expect(fireProNudge({ ...FREE, action: 'publish_intent' })).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const actions = fetchMock.mock.calls.map(
      (_c, i) => call(i).body.action,
    );
    expect(actions).toEqual(['publish_intent', 'feed_cap', 'mini_site']);
  });

  it('treats a missing plan as free (logged-in user with no plan field)', () => {
    expect(fireProNudge({ loggedIn: true, plan: undefined, action: 'feed_cap' })).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('fireProNudge — eligibility gate (logged-in free users only)', () => {
  it('does not fire for paid plans (pro / agency / enterprise)', () => {
    for (const plan of ['pro', 'agency', 'enterprise'] as Plan[]) {
      expect(fireProNudge({ loggedIn: true, plan, action: 'feed_cap' })).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fire for logged-out visitors', () => {
    expect(fireProNudge({ loggedIn: false, plan: 'free', action: 'feed_cap' })).toBe(false);
    expect(fireProNudge({ loggedIn: false, plan: undefined, action: 'mini_site' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isFreePlan', () => {
  it('treats free / null / undefined as free, paid tiers as not free', () => {
    expect(isFreePlan('free')).toBe(true);
    expect(isFreePlan(null)).toBe(true);
    expect(isFreePlan(undefined)).toBe(true);
    expect(isFreePlan('pro')).toBe(false);
    expect(isFreePlan('agency')).toBe(false);
    expect(isFreePlan('enterprise')).toBe(false);
  });
});

describe('shouldShowUpgradeEntry — account-menu Upgrade visibility', () => {
  it('shows for logged-in free users (incl. no plan field)', () => {
    expect(shouldShowUpgradeEntry(true, 'free')).toBe(true);
    expect(shouldShowUpgradeEntry(true, undefined)).toBe(true);
    expect(shouldShowUpgradeEntry(true, null)).toBe(true);
  });

  it('hides for logged-in paid users', () => {
    for (const plan of ['pro', 'agency', 'enterprise'] as Plan[]) {
      expect(shouldShowUpgradeEntry(true, plan)).toBe(false);
    }
  });

  it('hides for logged-out visitors regardless of plan', () => {
    expect(shouldShowUpgradeEntry(false, 'free')).toBe(false);
    expect(shouldShowUpgradeEntry(false, undefined)).toBe(false);
  });
});
