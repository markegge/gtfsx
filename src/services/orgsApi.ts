import { ApiError, type ApiErrorCode } from './authApi';

export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type InviteRole = Exclude<OrgRole, 'owner'>;

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  memberCount: number;
  projectCount: number;
  createdAt: number;
}

export interface OrgInfo {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
  /** Timestamp of the latest logo upload, or null when no logo is set. */
  brandLogoUpdatedAt?: number | null;
}

export interface OrgMember {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  createdAt: number;
}

export interface OrgDetail {
  organization: OrgInfo;
  members: OrgMember[];
  projectCount: number;
}

export interface OrgInvitation {
  tokenHash: string;
  email: string | null;
  role: OrgRole;
  invitedBy: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface PendingInvitation {
  orgId: string;
  orgName: string;
  role: OrgRole;
  invitedBy: string | null;
  inviterName: string | null;
  expiresAt: number;
}

export interface CreateOrgResponse {
  organization: OrgInfo & { role: OrgRole };
}

export interface AcceptInvitationResponse {
  organization: OrgInfo;
  role: OrgRole;
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

export function listOrgs(): Promise<{ orgs: OrgSummary[] }> {
  return request<{ orgs: OrgSummary[] }>('/api/orgs');
}

export function createOrg(input: { slug: string; name: string }): Promise<CreateOrgResponse> {
  return request<CreateOrgResponse>('/api/orgs', { method: 'POST', body: input });
}

export function getOrg(id: string): Promise<OrgDetail> {
  return request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}`);
}

export function patchOrg(
  id: string,
  input: { name?: string; slug?: string },
): Promise<{ organization: OrgInfo }> {
  return request<{ organization: OrgInfo }>(`/api/orgs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteOrg(id: string): Promise<void> {
  return request<void>(`/api/orgs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listInvitations(orgId: string): Promise<{ invitations: OrgInvitation[] }> {
  return request<{ invitations: OrgInvitation[] }>(
    `/api/orgs/${encodeURIComponent(orgId)}/invitations`,
  );
}

export function createInvitation(
  orgId: string,
  input: { email: string; role: InviteRole },
): Promise<void> {
  return request<void>(`/api/orgs/${encodeURIComponent(orgId)}/invitations`, {
    method: 'POST',
    body: input,
  });
}

export function rescindInvitation(orgId: string, tokenHash: string): Promise<void> {
  return request<void>(
    `/api/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(tokenHash)}`,
    { method: 'DELETE' },
  );
}

export function listPendingInvitations(): Promise<{ invitations: PendingInvitation[] }> {
  return request<{ invitations: PendingInvitation[] }>('/api/orgs/invitations/pending');
}

export function acceptInvitation(input: { token: string }): Promise<AcceptInvitationResponse> {
  return request<AcceptInvitationResponse>('/api/orgs/invitations/accept', {
    method: 'POST',
    body: input,
  });
}

export function updateMemberRole(
  orgId: string,
  userId: string,
  input: { role: OrgRole },
): Promise<void> {
  return request<void>(
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: input },
  );
}

export function removeMember(orgId: string, userId: string): Promise<void> {
  return request<void>(
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export function transferOwnership(
  orgId: string,
  input: { newOwnerUserId: string },
): Promise<void> {
  return request<void>(`/api/orgs/${encodeURIComponent(orgId)}/transfer`, {
    method: 'POST',
    body: input,
  });
}

export async function uploadOrgLogo(orgId: string, file: File): Promise<{ organization: OrgInfo }> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/logo`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...BASE_HEADERS },
      body: form,
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }
  if (!res.ok) {
    let message = 'Logo upload failed';
    let code: ApiErrorCode = 'unknown';
    try {
      const data = await res.json() as { error?: string; message?: string };
      if (data?.message) message = data.message;
      if (data?.error) code = data.error as ApiErrorCode;
    } catch { /* ignore */ }
    throw new ApiError(code, message, res.status);
  }
  return res.json() as Promise<{ organization: OrgInfo }>;
}

export function deleteOrgLogo(orgId: string): Promise<{ organization: OrgInfo }> {
  return request<{ organization: OrgInfo }>(`/api/orgs/${encodeURIComponent(orgId)}/logo`, {
    method: 'DELETE',
  });
}

/**
 * Public URL for an org's brand logo, served from the FEEDS origin so
 * embed iframes can load it cross-origin without CORS issues. Returns
 * null when the org has no logo.
 */
export function orgLogoUrl(orgId: string, brandLogoUpdatedAt: number | null | undefined): string | null {
  if (!brandLogoUpdatedAt) return null;
  const feedsOrigin =
    (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
    (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
      ? 'https://staging-feeds.gtfsbuilder.net'
      : 'https://feeds.gtfsbuilder.net');
  return `${feedsOrigin}/_/orgs/${encodeURIComponent(orgId)}/logo?v=${brandLogoUpdatedAt}`;
}

export const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export function roleAtLeast(have: OrgRole, need: OrgRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}
