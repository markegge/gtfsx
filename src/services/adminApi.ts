import { ApiError, type ApiErrorCode } from './authApi';

export type UserStatus = 'active' | 'pending_verification' | 'disabled' | 'deleted_soft';

export interface AdminStats {
  users: {
    total: number;
    active: number;
    pending_verification: number;
    disabled: number;
    deleted_soft: number;
  };
  // Non-deleted users by subscription tier ('agency' = Agency tier).
  usersByPlan: { free: number; pro: number; agency: number; enterprise: number };
  organizations: { total: number };
  projects: { total: number; byOwnerType: { user: number; org: number } };
  snapshots: { total: number };
  publications: { total: number };
  signups: { last7d: number; last30d: number; allTime: number };
  activeUsers: { last24h: number; last7d: number; last30d: number };
  trend: {
    newUsersByWeek: { week: string; count: number }[];
    newProjectsByWeek: { week: string; count: number }[];
  };
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  staff: boolean;
  plan: 'free' | 'pro' | 'agency' | 'enterprise';
  planStatus: 'active' | 'past_due' | 'canceled' | 'trialing';
  createdAt: number;
  lastSessionAt: number | null;
  projectCount: number;
}

export interface AdminUserListResponse {
  users: AdminUserRow[];
  nextCursor: string | null;
}

export interface AdminUserMembership {
  orgId: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  slug: string;
  name: string;
}

export interface AdminAuditEvent {
  id: string;
  actorUserId: string | null;
  actorEmail?: string | null;
  subjectType: string;
  subjectId: string | null;
  action: string;
  metadataJson: string | null;
  ip: string | null;
  createdAt: number;
}

export interface AdminUserDetailResponse {
  user: AdminUserRow;
  memberships: AdminUserMembership[];
  auditEvents: AdminAuditEvent[];
}

export interface AdminOrgRow {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
  memberCount: number;
  projectCount: number;
}

export interface AdminOrgListResponse {
  orgs: AdminOrgRow[];
  nextCursor: string | null;
}

export interface AdminOrgMember {
  userId: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  createdAt: number;
  email: string;
  displayName: string;
}

export interface AdminOrgProject {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
}

export interface AdminOrgDetailResponse {
  org: {
    id: string;
    slug: string;
    name: string;
    createdAt: number;
  };
  members: AdminOrgMember[];
  projects: AdminOrgProject[];
}

export interface AdminAuditListResponse {
  events: AdminAuditEvent[];
  page: number;
  pageSize: number;
  hasNext: boolean;
}

export interface AdminAuditFilters {
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  action?: string;
  from?: number;
  to?: number;
  page?: number;
  pageSize?: number;
}

const BASE_HEADERS = { 'X-GB-Client': 'web' };

async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = init;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  if (!res.ok) {
    let code: ApiErrorCode = 'unknown';
    let message = res.statusText || 'Request failed';
    let extra: Record<string, unknown> = {};
    if (isJson) {
      try {
        const data = await res.json();
        if (data && typeof data === 'object') {
          const { error, message: msg, ...rest } = data as Record<string, unknown>;
          if (typeof error === 'string') code = error as ApiErrorCode;
          if (typeof msg === 'string') message = msg;
          extra = rest;
        }
      } catch {
        // ignore
      }
    }
    throw new ApiError(code, message, res.status, extra);
  }

  if (isJson) return (await res.json()) as T;
  return undefined as T;
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function getAdminStats(): Promise<AdminStats> {
  return request<AdminStats>('/api/admin/stats');
}

export function listAdminUsers(opts: {
  q?: string;
  status?: UserStatus | '';
  page?: number;
  pageSize?: number;
} = {}): Promise<AdminUserListResponse> {
  const qs = buildQuery({
    q: opts.q,
    status: opts.status || undefined,
    page: opts.page,
    pageSize: opts.pageSize,
  });
  return request<AdminUserListResponse>(`/api/admin/users${qs}`);
}

export function getAdminUser(id: string): Promise<AdminUserDetailResponse> {
  return request<AdminUserDetailResponse>(`/api/admin/users/${encodeURIComponent(id)}`);
}

export function patchAdminUser(
  id: string,
  input: { status?: 'active' | 'disabled'; staff?: boolean },
): Promise<{ user: { id: string; status: UserStatus; staff: boolean } }> {
  return request<{ user: { id: string; status: UserStatus; staff: boolean } }>(
    `/api/admin/users/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input },
  );
}

export function resendAdminUserVerification(id: string): Promise<void> {
  return request<void>(
    `/api/admin/users/${encodeURIComponent(id)}/resend-verification`,
    { method: 'POST' },
  );
}

export function softDeleteAdminUser(id: string): Promise<void> {
  return request<void>(`/api/admin/users/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
  });
}

export function impersonateUser(
  id: string,
): Promise<{ user: { id: string; email: string; status: UserStatus }; impersonator: { userId: string } }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/impersonate`, {
    method: 'POST',
  });
}

export function endImpersonation(): Promise<void> {
  return request<void>('/api/admin/end-impersonation', { method: 'POST' });
}

export function listAdminOrgs(opts: {
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<AdminOrgListResponse> {
  const qs = buildQuery({
    q: opts.q,
    page: opts.page,
    pageSize: opts.pageSize,
  });
  return request<AdminOrgListResponse>(`/api/admin/orgs${qs}`);
}

export function getAdminOrg(id: string): Promise<AdminOrgDetailResponse> {
  return request<AdminOrgDetailResponse>(`/api/admin/orgs/${encodeURIComponent(id)}`);
}

export function patchAdminOrgMember(
  orgId: string,
  userId: string,
  input: { role: 'owner' | 'admin' | 'editor' | 'viewer' },
): Promise<{ member: { userId: string; role: string } }> {
  return request(
    `/api/admin/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: input },
  );
}

export function removeAdminOrgMember(orgId: string, userId: string): Promise<void> {
  return request<void>(
    `/api/admin/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export function listAuditEvents(filters: AdminAuditFilters = {}): Promise<AdminAuditListResponse> {
  const qs = buildQuery({
    actorUserId: filters.actorUserId,
    subjectType: filters.subjectType,
    subjectId: filters.subjectId,
    action: filters.action,
    from: filters.from,
    to: filters.to,
    page: filters.page,
    pageSize: filters.pageSize,
  });
  return request<AdminAuditListResponse>(`/api/admin/audit${qs}`);
}

export interface AdminEventsSummaryRow {
  ref: string | null;
  visits: number;
  pageViews: number;
  editorSessions: number;
  exports: number;
  paywallViews: number;
}

export interface AdminEventsSummaryTotals {
  visits: number;
  pageViews: number;
  editorSessions: number;
  exports: number;
  paywallViews: number;
}

export interface AdminEventsSummaryResponse {
  rows: AdminEventsSummaryRow[];
  totals: AdminEventsSummaryTotals;
  from: number | null;
  to: number | null;
}

export function getEventsSummary(opts: {
  from?: number;
  to?: number;
} = {}): Promise<AdminEventsSummaryResponse> {
  const qs = buildQuery({ from: opts.from, to: opts.to });
  return request<AdminEventsSummaryResponse>(`/api/admin/events/summary${qs}`);
}

export function auditCsvUrl(filters: AdminAuditFilters = {}): string {
  const qs = buildQuery({
    actorUserId: filters.actorUserId,
    subjectType: filters.subjectType,
    subjectId: filters.subjectId,
    action: filters.action,
    from: filters.from,
    to: filters.to,
  });
  return `/api/admin/audit.csv${qs}`;
}

export const STAFF_IMPERSONATOR_KEY = 'gb_staff_id';
