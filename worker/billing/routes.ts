import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { requireAuth } from '../auth/middleware';
import { forbidden, notFound, validationFailed, paymentRequired, badGateway, ApiError } from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
import { requireOrgRole } from '../orgs/routes';
import { getStripe, resolvePriceId, billingReady, isStripeError, type Interval } from './stripe';
import { handleStripeWebhook } from './webhooks';
import {
  countPublishedFeeds,
  getOwnerPlan,
  getOwnerQuotas,
} from '../projects/quotas';
import { PLAN_CATALOG } from './plans';
import { ulid } from 'ulidx';

export const billingRouter = new Hono<AppContext>();

// ─── Public endpoints (no auth) ────────────────────────────────────────────

billingRouter.get('/plans', async (c) => {
  // Public catalog used by /pricing. Doesn't include Price IDs (those are
  // worker-side) — only display copy and amounts.
  return c.json({
    plans: PLAN_CATALOG,
    billingEnabled: c.env.BILLING_ENABLED === 'true',
  });
});

// Webhook endpoint. NO auth middleware here — the signature header is the auth.
// Mounted before requireClientHeader by index.ts route ordering.
billingRouter.post('/webhooks/stripe', async (c) => {
  return handleStripeWebhook(c.req.raw, c.env);
});

// ─── Authed endpoints ──────────────────────────────────────────────────────

billingRouter.use('/me', requireAuth);
billingRouter.use('/checkout', requireAuth);
billingRouter.use('/portal', requireAuth);

billingRouter.get('/me', async (c) => {
  const user = c.var.user!;
  const row = await c.env.DB.prepare(
    `SELECT plan, plan_status, plan_renewal_at, plan_seat_count, stripe_customer_id, plan_expires_at
       FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<{
      plan: string;
      plan_status: string;
      plan_renewal_at: number | null;
      plan_seat_count: number;
      stripe_customer_id: string | null;
      plan_expires_at: number | null;
    }>();
  if (!row) throw notFound('User not found');

  const quotas = await getOwnerQuotas(c.env, 'user', user.id);
  const usedProjects = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM feed_project WHERE owner_type = 'user' AND owner_id = ? AND deleted_at IS NULL`)
    .bind(user.id)
    .first<{ n: number }>();
  const usedPublished = await countPublishedFeeds(c.env, 'user', user.id);

  return c.json({
    owner: { type: 'user', id: user.id },
    plan: row.plan,
    planStatus: row.plan_status,
    planRenewalAt: row.plan_renewal_at,
    planSeatCount: row.plan_seat_count,
    planExpiresAt: row.plan_expires_at,
    hasStripeCustomer: !!row.stripe_customer_id,
    quotas: {
      projects: { used: usedProjects?.n ?? 0, limit: quotas.projects },
      publishedFeeds: { used: usedPublished, limit: quotas.publishedFeeds },
      snapshotsPerProject: { limit: quotas.snapshotsPerProject },
      blobBytes: { limit: quotas.blobBytes },
    },
  });
});

billingRouter.use('/orgs/:id', requireAuth);
billingRouter.get('/orgs/:id', async (c) => {
  const user = c.var.user!;
  const orgId = c.req.param('id');
  // Any member can read; admins are needed for checkout/portal.
  await requireOrgRole(c.env, user, orgId);

  const row = await c.env.DB.prepare(
    `SELECT plan, plan_status, plan_renewal_at, plan_seat_count, stripe_customer_id, plan_expires_at
       FROM organization WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId)
    .first<{
      plan: string;
      plan_status: string;
      plan_renewal_at: number | null;
      plan_seat_count: number;
      stripe_customer_id: string | null;
      plan_expires_at: number | null;
    }>();
  if (!row) throw notFound('Organization not found');

  const quotas = await getOwnerQuotas(c.env, 'org', orgId);
  const usedProjects = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM feed_project WHERE owner_type = 'org' AND owner_id = ? AND deleted_at IS NULL`)
    .bind(orgId)
    .first<{ n: number }>();
  const usedPublished = await countPublishedFeeds(c.env, 'org', orgId);
  const membersRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM organization_membership WHERE org_id = ?`)
    .bind(orgId)
    .first<{ n: number }>();

  // Agency (internal id 'agency') and Enterprise are flat-priced with unlimited members; plan_seat_count
  // is left at 1 for legacy Stripe accounting but should not gate membership.
  // Surface a large sentinel so the UI's `unbounded` quota meter renders it
  // as "Unlimited".
  const seatsLimit = row.plan === 'agency' || row.plan === 'enterprise'
    ? 99999
    : row.plan_seat_count;

  return c.json({
    owner: { type: 'org', id: orgId },
    plan: row.plan,
    planStatus: row.plan_status,
    planRenewalAt: row.plan_renewal_at,
    planSeatCount: row.plan_seat_count,
    planExpiresAt: row.plan_expires_at,
    hasStripeCustomer: !!row.stripe_customer_id,
    quotas: {
      projects: { used: usedProjects?.n ?? 0, limit: quotas.projects },
      publishedFeeds: { used: usedPublished, limit: quotas.publishedFeeds },
      snapshotsPerProject: { limit: quotas.snapshotsPerProject },
      blobBytes: { limit: quotas.blobBytes },
      seats: { used: membersRow?.n ?? 0, limit: seatsLimit },
    },
  });
});

// GH #68: record a checkout_started pro-intent signal (per-account, authenticated)
// so the warm-cohort export can rank accounts that began the upgrade path. Writes
// to pro_intent (migration 0023). Best-effort — swallow every error so a logging
// failure can never break checkout. Exported for a focused unit test (the full
// /checkout route needs Stripe env the worker test pool doesn't have).
export async function recordCheckoutStarted(
  env: Env,
  userId: string,
  plan: string,
  interval: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO pro_intent (id, user_id, ts, action, source) VALUES (?, ?, ?, 'checkout_started', ?)`,
    )
      .bind(ulid(), userId, Date.now(), `${plan}_${interval}`)
      .run();
  } catch {
    // instrumentation must never affect checkout
  }
}

// Self-serve checkout supports the single flat-priced plan (Planner — DB id
// 'agency', billed to an org). Enterprise is sales-led.
const checkoutSchema = z.object({
  ownerType: z.enum(['user', 'org']),
  ownerId: z.string().min(1),
  plan: z.enum(['agency']),
  interval: z.enum(['month', 'year']),
});

async function parseJson<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

// A Stripe SDK error message can embed our secret key verbatim — e.g.
// "Expired API Key provided: sk_live_…a1cjVy" — so it must NEVER be echoed to
// the browser. Log the full detail server-side (Worker logs) and hand the
// client a generic, key-safe message. Used by every Stripe-call catch block.
export function stripeFailure(
  err: { message?: string; code?: string; type?: string; statusCode?: number },
  action: string,
): ApiError {
  console.error(`[billing] Stripe error during ${action}`, {
    message: err.message,
    code: err.code,
    type: err.type,
    statusCode: err.statusCode,
  });
  return badGateway(
    'Payment processing is temporarily unavailable. Please try again in a moment — if it keeps happening, email hello@gtfsx.com.',
    { reason: 'stripe_error' },
  );
}

billingRouter.post('/checkout', async (c) => {
  if (!billingReady(c.env)) {
    throw new ApiError(503, 'internal', 'Billing is not yet enabled in this environment.');
  }
  const user = c.var.user!;
  const body = await parseJson(c, checkoutSchema);

  // Authorization on owner:
  //   - user/self: must match c.var.user.id
  //   - org: must be admin or owner of the org
  if (body.ownerType === 'user') {
    // Planner (DB id 'agency') is always billed to an organization.
    throw validationFailed('Planner plans must be billed to an organization.');
  }
  await requireOrgRole(c.env, user, body.ownerId, 'admin');

  const interval: Interval = body.interval;
  // Planner (DB id 'agency') is flat-priced with unlimited seats, so every
  // self-serve checkout is quantity=1; Stripe quantity does not track seats.
  const quantity = 1;

  const priceId = resolvePriceId(c.env, body.plan, interval);
  const stripe = getStripe(c.env);

  // Reuse the existing Stripe Customer for this org if there is one.
  const existingCustomerId = await loadStripeCustomerId(c.env, body.ownerType, body.ownerId);
  let customerId = existingCustomerId;

  // The post-checkout redirect needs to land on the org's billing page, which
  // is keyed by slug.
  const orgSlug = await loadOrgSlug(c.env, body.ownerId);
  const billingPath = orgSlug
    ? `/orgs/${encodeURIComponent(orgSlug)}/billing`
    : '/account/billing';

  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>;
  try {
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: await loadOrgName(c.env, body.ownerId),
        metadata: {
          owner_type: body.ownerType,
          owner_id: body.ownerId,
          initiated_by_user: user.id,
        },
      });
      customerId = customer.id;
      await c.env.DB.prepare(`UPDATE organization SET stripe_customer_id = ? WHERE id = ?`)
        .bind(customerId, body.ownerId)
        .run();
    }

    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity }],
      metadata: {
        owner_type: body.ownerType,
        owner_id: body.ownerId,
        target_plan: body.plan,
        target_interval: interval,
        initiated_by_user: user.id,
      },
      subscription_data: {
        metadata: {
          owner_type: body.ownerType,
          owner_id: body.ownerId,
          target_plan: body.plan,
          // Captured here too (not just on the session) so trial_will_end
          // webhook handlers can email the right user — the webhook event
          // delivers a Subscription, not a checkout session.
          initiated_by_user_id: user.id,
        },
        // 14-day free trial on Planner (internal id 'agency'). Card up front
        // per Stripe defaults — payment fails closed at trial end if the
        // card is invalid (Stripe pauses the subscription and emits
        // invoice.payment_failed which the existing handler logs).
        trial_period_days: 14,
      },
      success_url: `${c.env.APP_ORIGIN}${billingPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${c.env.APP_ORIGIN}${billingPath}?checkout=canceled`,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
    });
  } catch (err) {
    if (isStripeError(err)) {
      throw stripeFailure(err, 'checkout.sessions.create');
    }
    throw err;
  }

  await c.env.DB.prepare(
    `INSERT INTO checkout_session
       (id, owner_type, owner_id, target_plan, target_interval, quantity, initiated_by_user, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(session.id, body.ownerType, body.ownerId, body.plan, interval, quantity, user.id, Date.now())
    .run();

  // GH #68: the upgrade path has started — record it (best-effort, never blocks).
  await recordCheckoutStarted(c.env, user.id, body.plan, interval);

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: body.ownerType === 'org' ? 'org' : 'user',
    subjectId: body.ownerId,
    action: 'billing.checkout_started',
    metadata: { plan: body.plan, interval, quantity, sessionId: session.id },
    ip: clientIp(c.req.raw),
  });

  return c.json({ url: session.url, sessionId: session.id });
});

const portalSchema = z.object({
  ownerType: z.enum(['user', 'org']),
  ownerId: z.string().min(1),
  returnUrl: z.string().url().optional(),
});

billingRouter.post('/portal', async (c) => {
  if (!billingReady(c.env)) {
    throw new ApiError(503, 'internal', 'Billing is not yet enabled in this environment.');
  }
  const user = c.var.user!;
  const body = await parseJson(c, portalSchema);

  if (body.ownerType === 'user') {
    if (body.ownerId !== user.id) throw forbidden('Cannot open billing portal for another user.');
  } else {
    await requireOrgRole(c.env, user, body.ownerId, 'admin');
  }

  const customerId = await loadStripeCustomerId(c.env, body.ownerType, body.ownerId);
  if (!customerId) {
    throw paymentRequired('No subscription on file — start a checkout flow first.', {
      currentPlan: await getOwnerPlan(c.env, body.ownerType, body.ownerId),
    });
  }

  const stripe = getStripe(c.env);
  const returnUrl =
    body.returnUrl
    ?? (body.ownerType === 'user'
      ? `${c.env.APP_ORIGIN}/account/billing`
      : `${c.env.APP_ORIGIN}/orgs/${body.ownerId}/billing`);

  let session: Awaited<ReturnType<typeof stripe.billingPortal.sessions.create>>;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      configuration: c.env.STRIPE_PORTAL_CONFIG_ID || undefined,
    });
  } catch (err) {
    if (isStripeError(err)) {
      throw stripeFailure(err, 'billingPortal.sessions.create');
    }
    throw err;
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: body.ownerType === 'org' ? 'org' : 'user',
    subjectId: body.ownerId,
    action: 'billing.portal_opened',
    ip: clientIp(c.req.raw),
  });

  return c.json({ url: session.url });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadStripeCustomerId(
  env: AppContext['Bindings'],
  ownerType: 'user' | 'org',
  ownerId: string,
): Promise<string | null> {
  if (ownerType === 'user') {
    const row = await env.DB.prepare(`SELECT stripe_customer_id FROM user WHERE id = ?`)
      .bind(ownerId)
      .first<{ stripe_customer_id: string | null }>();
    return row?.stripe_customer_id ?? null;
  }
  const row = await env.DB.prepare(`SELECT stripe_customer_id FROM organization WHERE id = ?`)
    .bind(ownerId)
    .first<{ stripe_customer_id: string | null }>();
  return row?.stripe_customer_id ?? null;
}

async function loadOrgName(env: AppContext['Bindings'], orgId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`SELECT name FROM organization WHERE id = ?`)
    .bind(orgId)
    .first<{ name: string | null }>();
  return row?.name ?? undefined;
}

async function loadOrgSlug(env: AppContext['Bindings'], orgId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT slug FROM organization WHERE id = ?`)
    .bind(orgId)
    .first<{ slug: string | null }>();
  return row?.slug ?? null;
}
