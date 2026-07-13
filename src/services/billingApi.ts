// Billing API client. Mirrors the request/error pattern from authApi.ts.

import { apiRequest, restParseError } from './apiClient';

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

function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return apiRequest<T>(path, init, { parseError: restParseError });
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
