// Stripe webhook receiver.
//
// All event handlers are idempotent: replaying any event must produce the
// same end state. Idempotency is enforced by the stripe_event table
// (Stripe's evt_xxx is the PK). Duplicate events short-circuit to 200.

import Stripe from 'stripe';
import type { Env } from '../env';
import { ulid } from 'ulidx';
import { getStripe, planFromPriceId } from './stripe';
import { sha256Hex } from '../util/crypto';
import { logAudit } from '../util/audit';
import type { Plan, OwnerType } from '../projects/quotas';
import { isPlan } from '../projects/quotas';
import { sendTrialEndingEmail } from '../email';
import { PLAN_CATALOG } from './plans';

const RELEVANT_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  // Fires ~3 days before a trial ends. Used to send the trial-ending
  // reminder email. Subscribed via scripts/setup-stripe.ts.
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

type RelevantEvent = (typeof RELEVANT_EVENTS)[number];

function isRelevantEvent(type: string): type is RelevantEvent {
  return (RELEVANT_EVENTS as readonly string[]).includes(type);
}

// In Stripe API 2025-04-30+, Invoice.subscription was replaced by
// parent.subscription_details.subscription. Read whichever path is populated.
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent;
  if (!parent || parent.type !== 'subscription_details') return null;
  const subDetails = parent.subscription_details;
  if (!subDetails) return null;
  const sub = subDetails.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
}

// ─── Entry point ───────────────────────────────────────────────────────────

export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SIGNING_SECRET) {
    return new Response('Webhook secret not configured', { status: 503 });
  }
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature', { status: 400 });
  }

  const rawBody = await req.text();
  const stripe = getStripe(env);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SIGNING_SECRET,
    );
  } catch (err) {
    console.error('[billing] webhook signature verification failed', err);
    return new Response('Invalid signature', { status: 400 });
  }

  // Idempotency: insert into stripe_event first; if it already exists, this
  // is a replay and we return 200 without re-running side effects.
  const payloadHash = await sha256Hex(rawBody);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO stripe_event (id, type, payload_hash, received_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(event.id, event.type, payloadHash, now)
      .run();
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
      console.log(`[billing] duplicate event ${event.id} short-circuiting`);
      return new Response('OK (duplicate)', { status: 200 });
    }
    throw err;
  }

  if (!isRelevantEvent(event.type)) {
    // Mark processed so the unprocessed-events index doesn't fill up.
    await env.DB.prepare(`UPDATE stripe_event SET processed_at = ? WHERE id = ?`)
      .bind(now, event.id)
      .run();
    return new Response('OK (ignored)', { status: 200 });
  }

  try {
    await dispatchEvent(env, event);
    await env.DB.prepare(`UPDATE stripe_event SET processed_at = ? WHERE id = ?`)
      .bind(Date.now(), event.id)
      .run();
    return new Response('OK', { status: 200 });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[billing] webhook handler failed for ${event.type}:`, err);
    await env.DB.prepare(`UPDATE stripe_event SET error = ? WHERE id = ?`)
      .bind(msg.slice(0, 500), event.id)
      .run();
    // Return 500 so Stripe retries.
    return new Response(`Handler error: ${msg}`, { status: 500 });
  }
}

// ─── Event dispatcher ──────────────────────────────────────────────────────

async function dispatchEvent(env: Env, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(env, event.data.object as Stripe.Checkout.Session);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await syncSubscription(env, event.data.object as Stripe.Subscription);
      return;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(env, event.data.object as Stripe.Subscription);
      return;
    case 'customer.subscription.trial_will_end':
      await handleTrialWillEnd(env, event.data.object as Stripe.Subscription);
      return;
    case 'invoice.paid':
      await handleInvoicePaid(env, event.data.object as Stripe.Invoice);
      return;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(env, event.data.object as Stripe.Invoice);
      return;
  }
}

// ─── Resolvers ─────────────────────────────────────────────────────────────

// Find the owner (user or org) for a Stripe subscription. Two paths:
//   1. The subscription's metadata.owner_type + owner_id (set at Checkout).
//   2. A stripe_customer_id we previously stored on user or organization.
async function resolveOwner(
  env: Env,
  sub: Stripe.Subscription,
): Promise<{ ownerType: OwnerType; ownerId: string } | null> {
  const meta = sub.metadata ?? {};
  if ((meta.owner_type === 'user' || meta.owner_type === 'org') && typeof meta.owner_id === 'string') {
    return { ownerType: meta.owner_type, ownerId: meta.owner_id };
  }
  // Fall back to lookup by stripe_customer_id.
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const userRow = await env.DB.prepare(`SELECT id FROM user WHERE stripe_customer_id = ? LIMIT 1`)
    .bind(customerId)
    .first<{ id: string }>();
  if (userRow) return { ownerType: 'user', ownerId: userRow.id };
  const orgRow = await env.DB.prepare(`SELECT id FROM organization WHERE stripe_customer_id = ? LIMIT 1`)
    .bind(customerId)
    .first<{ id: string }>();
  if (orgRow) return { ownerType: 'org', ownerId: orgRow.id };
  return null;
}

// Decide which `plan` value the subscription corresponds to. Driven by the
// Stripe Product's `metadata.tier`, which the setup script populates.
function planFromSubscription(env: Env, sub: Stripe.Subscription): Plan | null {
  const item = sub.items.data[0];
  if (!item) return null;
  // Webhook payloads don't expand `price.product`, so we resolve via the Price
  // ID against our env-var lookup. This avoids a second Stripe API round-trip
  // on every event and works without the product object being expanded.
  const basePlan = planFromPriceId(env, item.price.id);
  if (basePlan && isPlan(basePlan)) return basePlan;
  return null;
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleCheckoutSessionCompleted(env: Env, session: Stripe.Checkout.Session): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE checkout_session SET completed_at = ? WHERE id = ? AND completed_at IS NULL`,
  )
    .bind(now, session.id)
    .run();

  // The subscription created from this checkout fires its own event; the
  // primary work happens there. We just stamp the session and (if the
  // session is the first one for this owner) record the stripe_customer_id.
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!customerId) return;

  const ownerType = session.metadata?.owner_type;
  const ownerId = session.metadata?.owner_id;
  if (!ownerType || !ownerId) return;

  if (ownerType === 'user') {
    await env.DB.prepare(
      `UPDATE user SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(customerId, now, ownerId)
      .run();
  } else if (ownerType === 'org') {
    await env.DB.prepare(`UPDATE organization SET stripe_customer_id = ? WHERE id = ?`)
      .bind(customerId, ownerId)
      .run();
  }
}

async function syncSubscription(env: Env, sub: Stripe.Subscription): Promise<void> {
  const owner = await resolveOwner(env, sub);
  if (!owner) {
    console.warn(`[billing] subscription ${sub.id} has no resolvable owner`);
    return;
  }
  const plan = planFromSubscription(env, sub);
  if (!plan) {
    console.warn(`[billing] subscription ${sub.id} has no resolvable plan`);
    return;
  }

  const item = sub.items.data[0];
  if (!item) return;
  const priceId = item.price.id;
  const quantity = item.quantity ?? 1;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // In Stripe API 2025-04-30+, current_period_* live on the SubscriptionItem,
  // not the Subscription itself. We take the (sole) line item's window.
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;

  const now = Date.now();
  const renewalAt = periodEnd ? periodEnd * 1000 : null;
  const trialEnd = sub.trial_end ? sub.trial_end * 1000 : null;
  const canceledAt = sub.canceled_at ? sub.canceled_at * 1000 : null;

  // Upsert into subscription table. SQLite syntax: ON CONFLICT(stripe_subscription_id).
  await env.DB.prepare(
    `INSERT INTO subscription
       (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
        plan, status, quantity, current_period_start, current_period_end,
        cancel_at_period_end, canceled_at, trial_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       owner_type = excluded.owner_type,
       owner_id = excluded.owner_id,
       stripe_price_id = excluded.stripe_price_id,
       plan = excluded.plan,
       status = excluded.status,
       quantity = excluded.quantity,
       current_period_start = excluded.current_period_start,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       canceled_at = excluded.canceled_at,
       trial_end = excluded.trial_end,
       updated_at = excluded.updated_at`,
  )
    .bind(
      ulid(),
      owner.ownerType,
      owner.ownerId,
      sub.id,
      customerId,
      priceId,
      plan,
      sub.status,
      quantity,
      (periodStart ?? 0) * 1000,
      (periodEnd ?? 0) * 1000,
      sub.cancel_at_period_end ? 1 : 0,
      canceledAt,
      trialEnd,
      now,
      now,
    )
    .run();

  // Update cached plan on owner. Only when the subscription is active or
  // trialing — otherwise leave the existing cached plan in place until
  // explicit cancellation handler downgrades.
  const cachedPlan = sub.status === 'active' || sub.status === 'trialing' ? plan : null;
  if (cachedPlan) {
    if (owner.ownerType === 'user') {
      await env.DB.prepare(
        `UPDATE user
            SET plan = ?, stripe_customer_id = ?, plan_status = ?, plan_renewal_at = ?,
                plan_seat_count = ?, updated_at = ?
          WHERE id = ?`,
      )
        .bind(plan, customerId, sub.status, renewalAt, quantity, now, owner.ownerId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE organization
            SET plan = ?, stripe_customer_id = ?, plan_status = ?, plan_renewal_at = ?,
                plan_seat_count = ?
          WHERE id = ?`,
      )
        .bind(plan, customerId, sub.status, renewalAt, quantity, owner.ownerId)
        .run();
    }
  } else {
    // Past-due / unpaid: keep cached plan but flag plan_status.
    if (owner.ownerType === 'user') {
      await env.DB.prepare(
        `UPDATE user SET plan_status = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(sub.status, now, owner.ownerId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE organization SET plan_status = ? WHERE id = ?`,
      )
        .bind(sub.status, owner.ownerId)
        .run();
    }
  }

  await logAudit(env, {
    actorUserId: null,
    subjectType: owner.ownerType === 'org' ? 'org' : 'user',
    subjectId: owner.ownerId,
    action: 'billing.subscription_sync',
    metadata: { stripeSubscriptionId: sub.id, plan, status: sub.status, quantity },
  });
}

async function handleSubscriptionDeleted(env: Env, sub: Stripe.Subscription): Promise<void> {
  const owner = await resolveOwner(env, sub);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE subscription SET status = 'canceled', canceled_at = ?, updated_at = ?
       WHERE stripe_subscription_id = ?`,
  )
    .bind(now, now, sub.id)
    .run();

  if (owner) {
    if (owner.ownerType === 'user') {
      await env.DB.prepare(
        `UPDATE user SET plan = 'free', plan_status = 'canceled', plan_renewal_at = NULL, updated_at = ? WHERE id = ?`,
      )
        .bind(now, owner.ownerId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE organization SET plan = 'free', plan_status = 'canceled', plan_renewal_at = NULL WHERE id = ?`,
      )
        .bind(owner.ownerId)
        .run();
    }
    await logAudit(env, {
      actorUserId: null,
      subjectType: owner.ownerType === 'org' ? 'org' : 'user',
      subjectId: owner.ownerId,
      action: 'billing.subscription_canceled',
      metadata: { stripeSubscriptionId: sub.id },
    });
  }
}

async function handleInvoicePaid(env: Env, invoice: Stripe.Invoice): Promise<void> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return;
  // The matching customer.subscription.updated event will sync period dates;
  // here we just clear past_due if present and log the payment.
  const now = Date.now();
  await env.DB.prepare(`UPDATE subscription SET status = 'active', updated_at = ? WHERE stripe_subscription_id = ? AND status = 'past_due'`)
    .bind(now, subId)
    .run();

  const subRow = await env.DB.prepare(
    `SELECT owner_type, owner_id FROM subscription WHERE stripe_subscription_id = ?`,
  )
    .bind(subId)
    .first<{ owner_type: string; owner_id: string }>();
  if (subRow) {
    if (subRow.owner_type === 'user') {
      await env.DB.prepare(`UPDATE user SET plan_status = 'active', updated_at = ? WHERE id = ? AND plan_status = 'past_due'`)
        .bind(now, subRow.owner_id)
        .run();
    } else {
      await env.DB.prepare(`UPDATE organization SET plan_status = 'active' WHERE id = ? AND plan_status = 'past_due'`)
        .bind(subRow.owner_id)
        .run();
    }
    await logAudit(env, {
      actorUserId: null,
      subjectType: subRow.owner_type as 'user' | 'org',
      subjectId: subRow.owner_id,
      action: 'billing.invoice_paid',
      metadata: { stripeSubscriptionId: subId, amount: invoice.amount_paid },
    });
  }
}

async function handleInvoicePaymentFailed(env: Env, invoice: Stripe.Invoice): Promise<void> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return;
  const subRow = await env.DB.prepare(
    `SELECT owner_type, owner_id FROM subscription WHERE stripe_subscription_id = ?`,
  )
    .bind(subId)
    .first<{ owner_type: string; owner_id: string }>();
  if (!subRow) return;

  const now = Date.now();
  await env.DB.prepare(`UPDATE subscription SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`)
    .bind(now, subId)
    .run();

  if (subRow.owner_type === 'user') {
    await env.DB.prepare(`UPDATE user SET plan_status = 'past_due', updated_at = ? WHERE id = ?`)
      .bind(now, subRow.owner_id)
      .run();
  } else {
    await env.DB.prepare(`UPDATE organization SET plan_status = 'past_due' WHERE id = ?`)
      .bind(subRow.owner_id)
      .run();
  }

  await logAudit(env, {
    actorUserId: null,
    subjectType: subRow.owner_type as 'user' | 'org',
    subjectId: subRow.owner_id,
    action: 'billing.invoice_failed',
    metadata: { stripeSubscriptionId: subId, amount: invoice.amount_due },
  });
}

// ─── Trial-ending reminder ────────────────────────────────────────────────
//
// Stripe fires customer.subscription.trial_will_end ~3 days before a trial
// ends. Email the user who initiated the checkout (captured in subscription
// metadata at checkout time) so they have a concrete heads-up + a path to
// either keep Agency, switch to Pro, or cancel. Idempotency is handled by
// the outer stripe_event row insert — duplicate deliveries skip the
// dispatcher entirely.
async function handleTrialWillEnd(env: Env, sub: Stripe.Subscription): Promise<void> {
  const trialEndUnix = sub.trial_end;
  if (!trialEndUnix) return; // Defensive — Stripe only fires this for trials.

  const initiatedBy = sub.metadata?.initiated_by_user_id;
  if (!initiatedBy) {
    console.warn(`[billing] trial_will_end on ${sub.id}: no initiated_by_user_id on subscription metadata`);
    return;
  }

  // Send to the user who initiated the checkout (their billing context).
  const userRow = await env.DB.prepare(
    `SELECT email FROM user WHERE id = ?`,
  ).bind(initiatedBy).first<{ email: string }>();
  if (!userRow?.email) {
    console.warn(`[billing] trial_will_end on ${sub.id}: user ${initiatedBy} not found`);
    return;
  }

  // The subscription's metadata.owner_type is 'org' for Agency; look up the
  // slug so the "Manage subscription" link points at the org's billing page.
  let manageLink = `${env.APP_ORIGIN}/account/billing`;
  const ownerType = sub.metadata?.owner_type;
  const ownerId = sub.metadata?.owner_id;
  if (ownerType === 'org' && ownerId) {
    const orgRow = await env.DB.prepare(
      `SELECT slug FROM organization WHERE id = ?`,
    ).bind(ownerId).first<{ slug: string }>();
    if (orgRow?.slug) {
      manageLink = `${env.APP_ORIGIN}/orgs/${encodeURIComponent(orgRow.slug)}/billing`;
    }
  }

  // Format the trial end date in the user's apparent locale. We don't know
  // their tz, so use UTC — close enough for a "your trial ends Tuesday" cue.
  const trialEndDate = new Date(trialEndUnix * 1000).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

  // Pull the displayed monthly price from the catalog rather than hardcoding.
  const targetPlan = sub.metadata?.target_plan as Plan | undefined;
  const planEntry = PLAN_CATALOG.find((p) => p.plan === targetPlan);
  const monthlyPriceLabel = planEntry?.monthlyPriceUsd
    ? `$${planEntry.monthlyPriceUsd}/mo`
    : 'the subscription rate';

  try {
    await sendTrialEndingEmail(env, userRow.email, {
      trialEndDate,
      monthlyPriceLabel,
      manageLink,
      switchToProLink: `${env.APP_ORIGIN}/pricing#pro`,
    });
  } catch (err) {
    console.error(`[billing] trial_will_end email failed for ${sub.id}:`, err);
    // Don't rethrow — Stripe would re-deliver the webhook on a 5xx and
    // re-send the email. Logging here is enough; we'd rather the webhook
    // ack succeed and the audit row record the attempt.
  }

  await logAudit(env, {
    actorUserId: null,
    subjectType: (sub.metadata?.owner_type === 'org' ? 'org' : 'user') as 'user' | 'org',
    subjectId: sub.metadata?.owner_id ?? initiatedBy,
    action: 'billing.trial_will_end_notified',
    metadata: { stripeSubscriptionId: sub.id, trialEnd: trialEndUnix },
  });
}
