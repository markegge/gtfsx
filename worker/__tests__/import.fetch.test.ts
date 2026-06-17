// GET /api/import/fetch?url=<URL> — external feed fetch via fetchFeedZip().
//
// The magic-byte sniff (PK\x03\x04 / PK\x05\x06) is authoritative: a real ZIP
// imports regardless of the upstream Content-Type, and a genuine HTML page
// (no PK magic bytes) is cleanly rejected as not_zip. This covers feeds served
// at extension-less URLs (e.g. http://mychtransit.org/gtfs) that hand back a
// real zip under a generic/wrong Content-Type.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, resetDb } from './_setup';

const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

function zipBody(): Uint8Array {
  // Valid local-file-header magic bytes followed by arbitrary payload.
  const tail = new TextEncoder().encode('-zip-payload');
  const out = new Uint8Array(ZIP_MAGIC.length + tail.length);
  out.set(ZIP_MAGIC, 0);
  out.set(tail, ZIP_MAGIC.length);
  return out;
}

async function fetchImport(url: string): Promise<Response> {
  const client = makeClient();
  return client.get(`/api/import/fetch?url=${encodeURIComponent(url)}`);
}

describe('/api/import/fetch — external URL magic-byte sniff', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports a real ZIP even when served as Content-Type: text/html', async () => {
    const bytes = zipBody();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });

    const res = await fetchImport('http://mychtransit.org/gtfs');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const recvd = new Uint8Array(await res.arrayBuffer());
    expect(recvd).toEqual(bytes);
  });

  it('imports a real ZIP served as Content-Type: text/plain at an extension-less URL', async () => {
    const bytes = zipBody();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const res = await fetchImport('http://mychtransit.org/gtfs');
    expect(res.status).toBe(200);
    const recvd = new Uint8Array(await res.arrayBuffer());
    expect(recvd).toEqual(bytes);
  });

  it('still rejects a genuine HTML page (no PK magic bytes) as not_zip', async () => {
    const html = '<!DOCTYPE html><html><head><title>Not a feed</title></head><body>nope</body></html>';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });

    const res = await fetchImport('http://mychtransit.org/gtfs');
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_zip');
  });
});
