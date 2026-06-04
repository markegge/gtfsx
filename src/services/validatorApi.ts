// Client driver for validating the current feed against the canonical hosted
// MobilityData GTFS validator (https://gtfs-validator.mobilitydata.org).
//
// Flow (see worker/validator/routes.ts for the server side):
//   1. Export the current feed to a GTFS .zip with the existing export service.
//   2. POST /api/validator/create-job  → { jobId, uploadUrl }  (signed GCS PUT).
//   3. PUT the zip directly to `uploadUrl` (GCS allows CORS PUT from any origin)
//      — the bytes never transit our Worker.
//   4. Poll GET /api/validator/report?jobId=… every ~2.5s until the report is
//      ready, then return the normalized canonical notices.

import { ApiError } from './authApi';
import { exportGtfsZip } from './gtfsExport';

export interface CanonicalNotice {
  code: string;
  /** ERROR | WARNING | INFO */
  severity: string;
  totalNotices: number;
  sampleNotices: Record<string, unknown>[];
}

export interface CanonicalReport {
  validatorVersion: string | null;
  validatedAt: string | null;
  countryCode: string | null;
  notices: CanonicalNotice[];
}

export type ValidatorPhase =
  | 'exporting'
  | 'starting'
  | 'uploading'
  | 'processing'
  | 'done';

export interface ValidatorProgress {
  phase: ValidatorPhase;
  /** 0..1 for the upload phase; undefined for indeterminate phases. */
  uploadFraction?: number;
}

const POLL_INTERVAL_MS = 2500;
// MobilityData validations of editor-sized feeds finish in seconds, but big
// feeds or a busy service can take longer. Cap the wait so the UI never hangs.
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FEED_BYTES = 200 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createJob(countryCode?: string): Promise<{ jobId: string; uploadUrl: string }> {
  let res: Response;
  try {
    res = await fetch('/api/validator/create-job', {
      method: 'POST',
      headers: { 'X-GB-Client': 'web', 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ countryCode: countryCode ?? '' }),
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }
  if (!res.ok) {
    let message = 'Could not start the MobilityData validation.';
    try {
      const data = (await res.json()) as { message?: string };
      if (data?.message) message = data.message;
    } catch {
      /* ignore */
    }
    throw new ApiError('unknown', message, res.status);
  }
  return (await res.json()) as { jobId: string; uploadUrl: string };
}

// Direct browser → GCS PUT. Uses XHR so we get upload progress events.
function uploadZip(uploadUrl: string, zip: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError('unknown', `Upload to the validator failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network_error', 'Network error while uploading the feed.', 0));
    xhr.ontimeout = () => reject(new ApiError('unknown', 'Upload to the validator timed out.', 0));
    xhr.send(zip);
  });
}

type ReportResponse =
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'done'; report: CanonicalReport };

async function pollReport(jobId: string): Promise<CanonicalReport> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`/api/validator/report?jobId=${encodeURIComponent(jobId)}`, {
        headers: { 'X-GB-Client': 'web' },
        credentials: 'include',
      });
    } catch (e) {
      throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
    }
    if (!res.ok) {
      let message = 'Could not fetch the validation report.';
      try {
        const data = (await res.json()) as { message?: string };
        if (data?.message) message = data.message;
      } catch {
        /* ignore */
      }
      throw new ApiError('unknown', message, res.status);
    }
    const data = (await res.json()) as ReportResponse;
    if (data.status === 'done') return data.report;
    if (data.status === 'failed') {
      throw new ApiError('unknown', data.error || 'The MobilityData validator could not process this feed.', 422);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ApiError(
    'unknown',
    'The MobilityData validation is taking longer than expected. Try again in a few minutes.',
    504,
  );
}

/**
 * Export the current feed and validate it against the canonical hosted
 * MobilityData validator. Reports phase changes via `onProgress`.
 *
 * @param countryCode optional ISO 3166-1 alpha-2 code for region-aware rules.
 */
export async function validateWithMobilityData(
  onProgress?: (p: ValidatorProgress) => void,
  countryCode?: string,
): Promise<CanonicalReport> {
  onProgress?.({ phase: 'exporting' });
  const zip = await exportGtfsZip();
  if (zip.size > MAX_FEED_BYTES) {
    throw new ApiError(
      'unknown',
      `This feed is larger than the ${(MAX_FEED_BYTES / 1024 / 1024).toFixed(0)} MB validator limit.`,
      413,
    );
  }

  onProgress?.({ phase: 'starting' });
  const { jobId, uploadUrl } = await createJob(countryCode);

  onProgress?.({ phase: 'uploading', uploadFraction: 0 });
  await uploadZip(uploadUrl, zip, (f) => onProgress?.({ phase: 'uploading', uploadFraction: f }));

  onProgress?.({ phase: 'processing' });
  const report = await pollReport(jobId);

  onProgress?.({ phase: 'done' });
  return report;
}
