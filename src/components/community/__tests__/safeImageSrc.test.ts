import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { safeImageSrc } from '../markdownSafeUrl';

// safeImageSrc reads the SPA host from window.location. The component only runs
// client-side, so for these node-environment tests we stub a minimal window
// with a prod-like SPA host (www.gtfsx.com). VITE_FEEDS_ORIGIN is unset (as in
// prod builds), so the feeds origin resolves via the staging-aware fallback to
// feeds.gtfsx.com.
const realWindow = (globalThis as { window?: unknown }).window;

beforeAll(() => {
  (globalThis as { window?: unknown }).window = {
    location: { origin: 'https://www.gtfsx.com', host: 'www.gtfsx.com', hostname: 'www.gtfsx.com' },
  };
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

describe('safeImageSrc', () => {
  // Regression: feeds.gtfsx.com forum images used to be dropped to alt text
  // because the allowlist only contained the SPA host.
  it('allows forum images on the prod feeds origin', () => {
    const url = 'https://feeds.gtfsx.com/_forum-images/abc123.png';
    expect(safeImageSrc(url)).toBe(url);
  });

  it('allows relative forum-image paths', () => {
    expect(safeImageSrc('/_forum-images/x.png')).toBe('/_forum-images/x.png');
  });

  it('allows same-origin (SPA host) forum images', () => {
    const url = 'https://www.gtfsx.com/_forum-images/y.png';
    expect(safeImageSrc(url)).toBe(url);
  });

  it('rejects forum images on an arbitrary host (falls back to alt text)', () => {
    expect(safeImageSrc('https://evil.example.com/_forum-images/track.png')).toBeNull();
  });

  it('rejects non-forum-images paths on the feeds origin', () => {
    expect(safeImageSrc('https://feeds.gtfsx.com/some-feed/logo.png')).toBeNull();
  });

  it('rejects non-http(s) protocols', () => {
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBeNull();
  });
});
