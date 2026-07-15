import { apiRequest, defaultParseError, ApiError, DEFAULT_HEADERS as BASE_HEADERS } from './apiClient';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type CatalogName = 'mobility_db' | 'transit_land';
export type CatalogStatus = 'pending' | 'submitted' | 'error' | string;

export interface CatalogSubmission {
  catalog: CatalogName;
  projectId?: string;
  externalFeedId?: string | null;
  optedInAt: number;
  lastSubmittedAt?: number | null;
  status: CatalogStatus;
  lastError?: string | null;
}

export type RtFeedKind = 'vehicle_positions' | 'trip_updates' | 'alerts';

export interface RtFeed {
  id: string;
  kind: RtFeedKind;
  url: string;
}

export interface RtFeedInput {
  kind: RtFeedKind;
  url: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  subjectType: string;
  subjectId: string | null;
  action: string;
  metadataJson: string | null;
  createdAt: number;
}

export interface UserUsage {
  projects: number;
  snapshots: number;
  storageBytes: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Low-level request helper — mirrors projectsApi.ts pattern
// ───────────────────────────────────────────────────────────────────────────

function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return apiRequest<T>(path, init);
}

// ───────────────────────────────────────────────────────────────────────────
// Catalog submissions
// ───────────────────────────────────────────────────────────────────────────

export function listCatalogSubmissions(
  projectId: string,
): Promise<{ submissions: CatalogSubmission[] }> {
  return requestJson<{ submissions: CatalogSubmission[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/catalog-submissions`,
  );
}

export function createCatalogSubmission(
  projectId: string,
  catalog: CatalogName,
): Promise<{ submission: CatalogSubmission }> {
  return requestJson<{ submission: CatalogSubmission }>(
    `/api/projects/${encodeURIComponent(projectId)}/catalog-submissions`,
    { method: 'POST', body: { catalog } },
  );
}

export function deleteCatalogSubmission(
  projectId: string,
  catalog: CatalogName,
): Promise<void> {
  return requestJson<void>(
    `/api/projects/${encodeURIComponent(projectId)}/catalog-submissions/${encodeURIComponent(catalog)}`,
    { method: 'DELETE' },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// RT feeds
// ───────────────────────────────────────────────────────────────────────────

export function listRtFeeds(projectId: string): Promise<{ feeds: RtFeed[] }> {
  return requestJson<{ feeds: RtFeed[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/rt-feeds`,
  );
}

export function putRtFeeds(
  projectId: string,
  feeds: RtFeedInput[],
): Promise<{ feeds: RtFeed[] }> {
  return requestJson<{ feeds: RtFeed[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/rt-feeds`,
    { method: 'PUT', body: { feeds } },
  );
}

export function deleteRtFeed(projectId: string, rtId: string): Promise<void> {
  return requestJson<void>(
    `/api/projects/${encodeURIComponent(projectId)}/rt-feeds/${encodeURIComponent(rtId)}`,
    { method: 'DELETE' },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Audit log
// ───────────────────────────────────────────────────────────────────────────

export function listProjectAudit(
  projectId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<{ events: AuditEvent[] }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', opts.before);
  const q = params.toString();
  return requestJson<{ events: AuditEvent[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/audit${q ? `?${q}` : ''}`,
  );
}

export function listMyAudit(
  opts: { limit?: number; before?: string } = {},
): Promise<{ events: AuditEvent[] }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', opts.before);
  const q = params.toString();
  return requestJson<{ events: AuditEvent[] }>(`/api/me/audit${q ? `?${q}` : ''}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Usage
// ───────────────────────────────────────────────────────────────────────────

export function getMyUsage(): Promise<{ user: UserUsage }> {
  return requestJson<{ user: UserUsage }>('/api/me/usage');
}

// ───────────────────────────────────────────────────────────────────────────
// Data export — streams a ZIP. Triggers a browser download.
//
// Not routed through requestJson because the response body is a binary blob.
// ───────────────────────────────────────────────────────────────────────────

export async function downloadMyExport(): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/me/export', {
      method: 'GET',
      credentials: 'include',
      headers: { ...BASE_HEADERS },
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }

  if (!res.ok) {
    // 429 rate limit surfaces a clear message; other errors fall through to
    // the generic error path so callers can render them.
    throw await defaultParseError(res);
  }

  const blob = await res.blob();

  // Pull filename from Content-Disposition if present.
  let filename = 'gtfs-builder-export.zip';
  const cd = res.headers.get('Content-Disposition');
  if (cd) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    if (match && match[1]) {
      try {
        filename = decodeURIComponent(match[1]);
      } catch {
        filename = match[1];
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the blob URL on the next tick so the download has a moment to initiate.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
