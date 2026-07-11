// Billing API client. Mirrors the request/error pattern from authApi.ts.

import { ApiError, type ApiErrorCode } from './authApi';

export type Plan =
  | 'free'
  | 'agency'
  | 'enterprise';

export type Interval = 'month' | 'year';

export type PlanStatus = 'active' | 'past_due' | 'canceled' | 'trialing';

export interface PlanCatalogEntry {
  plan: Plan;
  displayName: string;
  monthlyPriceUsd: number | null;
  annualPriceUsd: number | null;
  perSeat: boolean;
  tagline: string;
  features: string[];
  // Optional "see more" link below the bullet list (mirrors the worker
  // PlanCatalogEntry; e.g. the Agency card → /planning).
  detailsHref?: string;
  detailsLabel?: string;
}

export interface PlansResponse {
  plans: PlanCatalogEntry[];
  billingEnabled: boolean;
}

export interface OwnerBillingState {
  owner: { type: 'user' | 'org'; id: string };
  plan: Plan;
  planStatus: PlanStatus;
  planRenewalAt: number | null;
  planSeatCount: number;
  planExpiresAt: number | null;
  hasStripeCustomer: boolean;
  quotas: {
    projects: { used: number; limit: number };
    publishedFeeds: { used: number; limit: number };
    snapshotsPerProject: { limit: number };
    blobBytes: { limit: number };
  };
}

export interface CheckoutInput {
  ownerType: 'user' | 'org';
  ownerId: string;
  plan: 'agency';
  interval: Interval;
}

export interface CheckoutResponse {
  url: string;
  sessionId: string;
}

export interface PortalInput {
  ownerType: 'user' | 'org';
  ownerId: string;
  returnUrl?: string;
}

export interface PortalResponse {
  url: string;
}

async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = init;
  const headers: Record<string, string> = { 'X-GB-Client': 'web' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
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
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
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

export function fetchPlanCatalog(): Promise<PlansResponse> {
  return request<PlansResponse>('/api/billing/plans');
}

export function fetchUserBilling(): Promise<OwnerBillingState> {
  return request<OwnerBillingState>('/api/billing/me');
}

export interface OrgBillingState extends OwnerBillingState {
  quotas: OwnerBillingState['quotas'] & {
    seats: { used: number; limit: number };
  };
}

export function fetchOrgBilling(orgId: string): Promise<OrgBillingState> {
  return request<OrgBillingState>(`/api/billing/orgs/${encodeURIComponent(orgId)}`);
}

export function startCheckout(input: CheckoutInput): Promise<CheckoutResponse> {
  return request<CheckoutResponse>('/api/billing/checkout', { method: 'POST', body: input });
}

export function openBillingPortal(input: PortalInput): Promise<PortalResponse> {
  return request<PortalResponse>('/api/billing/portal', { method: 'POST', body: input });
}
