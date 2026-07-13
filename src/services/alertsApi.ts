// GTFS-Realtime Service Alerts authoring API client. Mirrors the request
// pattern in projectsApi.ts (cookie auth, ApiError on non-2xx).

import { apiRequest } from './apiClient';

export interface ActivePeriod {
  /** POSIX seconds. null/absent = active from the beginning of time. */
  start?: number | null;
  /** POSIX seconds. null/absent = active until further notice. */
  end?: number | null;
}

export interface InformedEntity {
  agency_id?: string;
  route_id?: string;
  route_type?: number;
  direction_id?: number;
  trip_id?: string;
  stop_id?: string;
}

export interface ServiceAlert {
  id: string;
  cause: string;
  effect: string;
  severity_level: string;
  header_text: string;
  description_text: string | null;
  url: string | null;
  active_periods: ActivePeriod[];
  informed_entities: InformedEntity[];
  status: 'draft' | 'active';
  created_at: number;
  updated_at: number;
}

export interface AlertInput {
  cause: string;
  effect: string;
  severity_level: string;
  header_text: string;
  description_text?: string | null;
  url?: string | null;
  active_periods: ActivePeriod[];
  informed_entities: InformedEntity[];
  status?: 'draft' | 'active';
}

export interface RtCoexistence {
  /** Our auto-wired alerts.pb URL (advertised in feed_info.json), if present. */
  managed_feed_url: string | null;
  /** An externally-hosted alerts feed the agency registered — forces a choice. */
  external_alerts_feed: { id: string; url: string } | null;
}

export interface AlertsListResponse {
  alerts: ServiceAlert[];
  rt_coexistence: RtCoexistence;
}

export interface AlertMutationResponse {
  alert: ServiceAlert;
  warnings: string[];
  rt_coexistence: RtCoexistence;
}

function requestJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return apiRequest<T>(path, init);
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/alerts`;

export function listAlerts(projectId: string): Promise<AlertsListResponse> {
  return requestJson<AlertsListResponse>(base(projectId));
}

export function createAlert(projectId: string, input: AlertInput): Promise<AlertMutationResponse> {
  return requestJson<AlertMutationResponse>(base(projectId), { method: 'POST', body: input });
}

export function updateAlert(projectId: string, alertId: string, input: AlertInput): Promise<AlertMutationResponse> {
  return requestJson<AlertMutationResponse>(`${base(projectId)}/${encodeURIComponent(alertId)}`, {
    method: 'PUT',
    body: input,
  });
}

export function setAlertStatus(
  projectId: string,
  alertId: string,
  status: 'draft' | 'active',
): Promise<{ alert: ServiceAlert }> {
  return requestJson<{ alert: ServiceAlert }>(`${base(projectId)}/${encodeURIComponent(alertId)}`, {
    method: 'PATCH',
    body: { status },
  });
}

export function deleteAlert(projectId: string, alertId: string): Promise<void> {
  return requestJson<void>(`${base(projectId)}/${encodeURIComponent(alertId)}`, { method: 'DELETE' });
}

export function previewAlerts(projectId: string): Promise<unknown> {
  return requestJson<unknown>(`${base(projectId)}/preview.json`);
}

/** Resolve the "external alerts feed already exists" conflict by adopting ours. */
export function adoptManagedAlertsFeed(projectId: string): Promise<{ rt_coexistence: RtCoexistence }> {
  return requestJson<{ rt_coexistence: RtCoexistence }>(`${base(projectId)}/rt-feed`, {
    method: 'POST',
    body: { resolution: 'replace_external' },
  });
}

// ─── Enum option lists for the editor dropdowns ──────────────────────────────

export const CAUSE_OPTIONS: { value: string; label: string }[] = [
  { value: 'UNKNOWN_CAUSE', label: 'Unknown' },
  { value: 'OTHER_CAUSE', label: 'Other' },
  { value: 'TECHNICAL_PROBLEM', label: 'Technical problem' },
  { value: 'STRIKE', label: 'Strike' },
  { value: 'DEMONSTRATION', label: 'Demonstration' },
  { value: 'ACCIDENT', label: 'Accident' },
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WEATHER', label: 'Weather' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'CONSTRUCTION', label: 'Construction' },
  { value: 'POLICE_ACTIVITY', label: 'Police activity' },
  { value: 'MEDICAL_EMERGENCY', label: 'Medical emergency' },
];

export const EFFECT_OPTIONS: { value: string; label: string }[] = [
  { value: 'UNKNOWN_EFFECT', label: 'Unknown' },
  { value: 'NO_SERVICE', label: 'No service' },
  { value: 'REDUCED_SERVICE', label: 'Reduced service' },
  { value: 'SIGNIFICANT_DELAYS', label: 'Significant delays' },
  { value: 'DETOUR', label: 'Detour' },
  { value: 'ADDITIONAL_SERVICE', label: 'Additional service' },
  { value: 'MODIFIED_SERVICE', label: 'Modified service' },
  { value: 'STOP_MOVED', label: 'Stop moved' },
  { value: 'NO_EFFECT', label: 'No effect' },
  { value: 'ACCESSIBILITY_ISSUE', label: 'Accessibility issue' },
  { value: 'OTHER_EFFECT', label: 'Other' },
];

export const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'UNKNOWN_SEVERITY', label: 'Unknown' },
  { value: 'INFO', label: 'Info' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'SEVERE', label: 'Severe' },
];
