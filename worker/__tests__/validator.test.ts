// /api/validator/* — proxy to the canonical MobilityData GTFS validator.
// Outbound fetches to the MobilityData hosts are mocked so the test is
// hermetic; we assert on the request shapes and the normalized responses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, resetDb } from './_setup';

const API_ROOT = 'https://gtfs-validator-web-mbzoxaljzq-ue.a.run.app';
const RESULTS_ROOT = 'https://gtfs-validator-results.mobilitydata.org';

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

describe('/api/validator', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /create-job', () => {
    it('proxies to MobilityData and returns jobId + uploadUrl', async () => {
      const client = makeClient();
      const calls: { url: string; method: string; body: unknown }[] = [];
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = urlOf(input);
        if (url === `${API_ROOT}/create-job`) {
          calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body });
          return new Response(
            JSON.stringify({ jobId: '11111111-2222-3333-4444-555555555555', url: 'https://storage.googleapis.com/up?sig=abc' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return original(input as RequestInfo, init);
      });

      const res = await client.post('/api/validator/create-job', { countryCode: 'us' });
      expect(res.status).toBe(200);
      const body = await client.json<{ jobId: string; uploadUrl: string }>(res);
      expect(body.jobId).toBe('11111111-2222-3333-4444-555555555555');
      expect(body.uploadUrl).toBe('https://storage.googleapis.com/up?sig=abc');

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      // Country code is uppercased and forwarded with no `url` (so the service
      // mints an upload URL).
      expect(JSON.parse(calls[0].body as string)).toEqual({ countryCode: 'US' });
    });

    it('rejects a malformed country code without calling upstream', async () => {
      const client = makeClient();
      const spy = vi.spyOn(globalThis, 'fetch');
      const res = await client.post('/api/validator/create-job', { countryCode: 'USA' });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('invalid_country');
      expect(spy).not.toHaveBeenCalled();
    });

    it('surfaces an upstream failure as 502', async () => {
      const client = makeClient();
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (urlOf(input) === `${API_ROOT}/create-job`) {
          return new Response('boom', { status: 500 });
        }
        return original(input as RequestInfo, init);
      });
      const res = await client.post('/api/validator/create-job', {});
      expect(res.status).toBe(502);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe('validator_error');
    });
  });

  describe('GET /report', () => {
    const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('returns pending while report.html is still 404', async () => {
      const client = makeClient();
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (urlOf(input) === `${RESULTS_ROOT}/${jobId}/report.html`) {
          return new Response(null, { status: 404 });
        }
        return original(input as RequestInfo, init);
      });
      const res = await client.get(`/api/validator/report?jobId=${jobId}`);
      const body = await client.json<{ status: string }>(res);
      expect(body.status).toBe('pending');
    });

    it('returns normalized notices when the report is ready', async () => {
      const client = makeClient();
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = urlOf(input);
        if (url === `${RESULTS_ROOT}/${jobId}/report.html`) return new Response(null, { status: 200 });
        if (url === `${RESULTS_ROOT}/${jobId}/execution_result.json`) {
          return new Response(JSON.stringify({ status: 'success', error: '' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === `${RESULTS_ROOT}/${jobId}/report.json`) {
          return new Response(
            JSON.stringify({
              summary: { validatorVersion: '8.0.1', validatedAt: '2026-06-04T00:00:00Z', countryCode: 'ZZ' },
              notices: [
                {
                  code: 'missing_recommended_field',
                  severity: 'WARNING',
                  totalNotices: 9,
                  sampleNotices: Array.from({ length: 8 }, (_, i) => ({ filename: 'routes.txt', csvRowNumber: i + 2 })),
                },
                { code: 'unknown_column', severity: 'INFO', totalNotices: 1, sampleNotices: [{ filename: 'stops.txt' }] },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return original(input as RequestInfo, init);
      });

      const res = await client.get(`/api/validator/report?jobId=${jobId}`);
      const body = await client.json<{
        status: string;
        report: { validatorVersion: string; notices: { code: string; severity: string; totalNotices: number; sampleNotices: unknown[] }[] };
      }>(res);
      expect(body.status).toBe('done');
      expect(body.report.validatorVersion).toBe('8.0.1');
      expect(body.report.notices).toHaveLength(2);
      const warn = body.report.notices.find((n) => n.code === 'missing_recommended_field')!;
      expect(warn.severity).toBe('WARNING');
      expect(warn.totalNotices).toBe(9);
      // Samples are capped at 5 by the proxy.
      expect(warn.sampleNotices).toHaveLength(5);
    });

    it('returns failed when the validator run did not succeed', async () => {
      const client = makeClient();
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = urlOf(input);
        if (url === `${RESULTS_ROOT}/${jobId}/report.html`) return new Response(null, { status: 200 });
        if (url === `${RESULTS_ROOT}/${jobId}/execution_result.json`) {
          return new Response(JSON.stringify({ status: 'error', error: 'Invalid zip' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return original(input as RequestInfo, init);
      });
      const res = await client.get(`/api/validator/report?jobId=${jobId}`);
      const body = await client.json<{ status: string; error: string }>(res);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('Invalid zip');
    });

    it('rejects a malformed job id', async () => {
      const client = makeClient();
      const spy = vi.spyOn(globalThis, 'fetch');
      const res = await client.get('/api/validator/report?jobId=not-a-uuid');
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
