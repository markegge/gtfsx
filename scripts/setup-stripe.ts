#!/usr/bin/env node
// Idempotently configure Stripe for GTFS·X freemium per docs/FREEMIUM_PLAN.md.
// Creates 3 Products, 4 Prices, the Customer Portal config, and registers the
// webhook endpoint. Re-runnable; existing objects are reused and only the
// signing secret on the webhook is fresh on a first-time create.
//
// Usage:
//   npx tsx scripts/setup-stripe.ts              # staging (default)
//   npx tsx scripts/setup-stripe.ts --live       # production webhook URL
//   npx tsx scripts/setup-stripe.ts --webhook-url=https://…
//   npx tsx scripts/setup-stripe.ts --rotate-webhook
//
// Reads STRIPE_SECRET_KEY from env or .dev.vars.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Stripe from 'stripe';

const cwd = process.cwd();
const args = process.argv.slice(2);
const liveMode = args.includes('--live');
const rotateWebhook = args.includes('--rotate-webhook');
const webhookUrlArg = args.find((a) => a.startsWith('--webhook-url='))?.slice('--webhook-url='.length);

const DEFAULT_WEBHOOK_URL = liveMode
  ? 'https://www.gtfsx.com/api/billing/webhooks/stripe'
  : 'https://staging.gtfsx.com/api/billing/webhooks/stripe';
const WEBHOOK_URL = webhookUrlArg ?? DEFAULT_WEBHOOK_URL;
const RETURN_URL_BASE = liveMode ? 'https://www.gtfsx.com' : 'https://staging.gtfsx.com';
const DESC_TAG = `gtfs-builder:freemium:${liveMode ? 'live' : 'staging'}`;

function loadSecretKey(): string {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  try {
    const vars = readFileSync(join(cwd, '.dev.vars'), 'utf8');
    for (const line of vars.split('\n')) {
      const m = line.match(/^STRIPE_SECRET_KEY\s*=\s*(.+)$/);
      if (m) return m[1].trim();
    }
  } catch {
    // .dev.vars missing — fall through to throwing below.
  }
  throw new Error('STRIPE_SECRET_KEY not set in env or .dev.vars');
}

const stripeKey = loadSecretKey();
if (liveMode && !stripeKey.startsWith('sk_live_')) {
  throw new Error('--live requires a live-mode key (sk_live_…)');
}
if (!liveMode && !stripeKey.startsWith('sk_test_')) {
  console.warn('Warning: secret key is not a test-mode key but --live was not passed.');
}

const stripe = new Stripe(stripeKey, { apiVersion: '2026-04-22.dahlia' });

console.log(`Stripe setup — ${liveMode ? 'LIVE' : 'TEST'} mode`);
console.log(`Webhook URL: ${WEBHOOK_URL}`);
console.log();

// ───────────────────────── Products ────────────────────────────────────────

interface ProductSpec {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, string>;
}

const PRODUCTS: ProductSpec[] = [
  {
    id: 'gtfsb_pro',
    name: 'GTFS·X Pro',
    description:
      'For individual transit agencies and small operators. Save up to 10 feeds, publish 1 feed to a stable URL, plus demographic coverage and cost estimation analysis.',
    metadata: { app_id: 'gtfsb_pro', tier: 'pro' },
  },
  {
    // Internal product id stays 'gtfsb_team' so existing subscriptions and the
    // worker tier matrix continue to resolve. Customer-facing name was renamed
    // Team → Agency in the May-2026 pricing v2 — receipts and portal copy
    // pick up the new name from the Product.name field.
    id: 'gtfsb_team',
    name: 'GTFS·X Agency',
    description:
      'For transit agencies and consultants planning routes and service. Unlimited saved feeds, publish up to 5, the full planning suite (demographic coverage, cost estimation, Title VI, ridership propensity), unlimited team members in your organization, and cross-org membership for consultants serving multiple clients.',
    metadata: { app_id: 'gtfsb_team', tier: 'team' },
  },
  {
    id: 'gtfsb_enterprise',
    name: 'GTFS·X Enterprise',
    description:
      'For state DOTs, RTAP networks, Cal-ITP, and large transit consortiums. Custom pricing, manually provisioned by staff. Contact hello@gtfsx.com.',
    metadata: { app_id: 'gtfsb_enterprise', tier: 'enterprise' },
  },
];

async function upsertProduct(spec: ProductSpec): Promise<Stripe.Product> {
  try {
    return await stripe.products.create({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      metadata: spec.metadata,
      tax_code: 'txcd_10103001', // SaaS — Business Use
    });
  } catch (e) {
    const err = e as Stripe.errors.StripeError;
    if (err.code === 'resource_already_exists' || err.message?.includes('already exists')) {
      return stripe.products.update(spec.id, {
        name: spec.name,
        description: spec.description,
        metadata: spec.metadata,
      });
    }
    throw e;
  }
}

console.log('Products:');
for (const spec of PRODUCTS) {
  const p = await upsertProduct(spec);
  console.log(`  ${p.id.padEnd(20)} ${p.name}`);
}
console.log();

// ───────────────────────── Prices ──────────────────────────────────────────

interface PriceSpec {
  lookupKey: string;
  productId: string;
  envName: string;
  unitAmount: number;
  interval: 'month' | 'year';
}

// Pricing v2 (May 2026): Agency tier moved $199→$299/mo and $1,999→$2,499/yr.
// Stripe Prices are immutable — to bump the amount we create new Price objects
// under fresh lookup keys (`_v2`), keep the originals around (active=true) so
// existing subscribers continue to bill at the old amount, and point the env
// vars at the new IDs so all new checkouts go through the v2 prices.
const PRICES: PriceSpec[] = [
  { lookupKey: 'gtfsb_pro_monthly',     productId: 'gtfsb_pro',  envName: 'STRIPE_PRICE_PRO_MONTHLY',  unitAmount: 4900,   interval: 'month' },
  { lookupKey: 'gtfsb_pro_annual',      productId: 'gtfsb_pro',  envName: 'STRIPE_PRICE_PRO_ANNUAL',   unitAmount: 49900,  interval: 'year'  },
  { lookupKey: 'gtfsb_team_monthly_v2', productId: 'gtfsb_team', envName: 'STRIPE_PRICE_TEAM_MONTHLY', unitAmount: 29900,  interval: 'month' },
  { lookupKey: 'gtfsb_team_annual_v2',  productId: 'gtfsb_team', envName: 'STRIPE_PRICE_TEAM_ANNUAL',  unitAmount: 249900, interval: 'year'  },
];

async function upsertPrice(spec: PriceSpec): Promise<Stripe.Price> {
  const existing = await stripe.prices.list({ lookup_keys: [spec.lookupKey], active: true, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return stripe.prices.create({
    product: spec.productId,
    unit_amount: spec.unitAmount,
    currency: 'usd',
    recurring: { interval: spec.interval },
    lookup_key: spec.lookupKey,
    tax_behavior: 'exclusive',
  });
}

console.log('Prices:');
const priceIds: Record<string, string> = {};
for (const spec of PRICES) {
  const p = await upsertPrice(spec);
  priceIds[spec.envName] = p.id;
  const dollars = (p.unit_amount! / 100).toFixed(2).padStart(8);
  console.log(`  ${spec.lookupKey.padEnd(28)} $${dollars}/${spec.interval.padEnd(5)}  ${p.id}`);
}
console.log();

// ───────────────────────── Customer Portal ─────────────────────────────────

console.log('Customer Portal:');
const existingConfigs = await stripe.billingPortal.configurations.list({ limit: 20 });
const ourConfig = existingConfigs.data.find((c) => c.metadata?.app_id === `gtfsb_default_${liveMode ? 'live' : 'test'}`);

const proPrices = PRICES.filter((p) => p.productId === 'gtfsb_pro').map((p) => priceIds[p.envName]);
const teamPrices = PRICES.filter((p) => p.productId === 'gtfsb_team').map((p) => priceIds[p.envName]);

const portalFeatures: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
  customer_update: {
    enabled: true,
    allowed_updates: ['email', 'name', 'tax_id', 'address'],
  },
  payment_method_update: { enabled: true },
  invoice_history: { enabled: true },
  subscription_cancel: {
    enabled: true,
    mode: 'at_period_end',
    cancellation_reason: {
      enabled: true,
      options: [
        'too_expensive',
        'missing_features',
        'switched_service',
        'unused',
        'customer_service',
        'too_complex',
        'low_quality',
        'other',
      ],
    },
  },
  subscription_update: {
    enabled: true,
    default_allowed_updates: ['price'],
    proration_behavior: 'create_prorations',
    products: [
      { product: 'gtfsb_pro', prices: proPrices },
      { product: 'gtfsb_team', prices: teamPrices },
    ],
  },
};

const portalParams: Stripe.BillingPortal.ConfigurationCreateParams = {
  business_profile: {
    headline: 'Manage your GTFS·X subscription',
  },
  default_return_url: `${RETURN_URL_BASE}/account/billing`,
  features: portalFeatures,
  metadata: { app_id: `gtfsb_default_${liveMode ? 'live' : 'test'}` },
};

let portalConfig: Stripe.BillingPortal.Configuration;
if (ourConfig) {
  portalConfig = await stripe.billingPortal.configurations.update(ourConfig.id, {
    business_profile: portalParams.business_profile,
    default_return_url: portalParams.default_return_url,
    features: portalFeatures,
    metadata: portalParams.metadata,
  });
  console.log(`  Updated portal config: ${portalConfig.id}`);
} else {
  portalConfig = await stripe.billingPortal.configurations.create(portalParams);
  console.log(`  Created portal config: ${portalConfig.id}`);
}
console.log();

// ───────────────────────── Webhook endpoint ────────────────────────────────

console.log('Webhook endpoint:');
const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

const existingHooks = await stripe.webhookEndpoints.list({ limit: 100 });
const matchingHook = existingHooks.data.find((h) => h.description === DESC_TAG && h.url === WEBHOOK_URL);

let webhookId: string;
let signingSecret: string | null = null;

if (matchingHook && !rotateWebhook) {
  webhookId = matchingHook.id;
  console.log(`  Reusing existing webhook ${webhookId} (signing secret preserved).`);
  console.log(`  Re-run with --rotate-webhook to delete + recreate (rotates signing secret).`);
} else {
  if (matchingHook) {
    await stripe.webhookEndpoints.del(matchingHook.id);
    console.log(`  Deleted existing webhook ${matchingHook.id} for rotation.`);
  }
  const created = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: WEBHOOK_EVENTS,
    description: DESC_TAG,
  });
  webhookId = created.id;
  signingSecret = created.secret ?? null;
  console.log(`  Created webhook ${webhookId}`);
}
console.log(`  ${WEBHOOK_EVENTS.length} events enabled`);
console.log();

// ───────────────────────── Output config file ─────────────────────────────

const outputPath = join(cwd, `.stripe-config-${liveMode ? 'live' : 'test'}.json`);
const output = {
  mode: liveMode ? 'live' : 'test',
  generated_at: new Date().toISOString(),
  products: PRODUCTS.map((p) => ({ id: p.id, app_id: p.metadata.app_id })),
  prices: priceIds,
  portal_config_id: portalConfig.id,
  webhook_id: webhookId,
  webhook_url: WEBHOOK_URL,
  webhook_signing_secret: signingSecret,
};
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`Wrote ${outputPath}`);
console.log();

// ───────────────────────── Summary ─────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log('Stripe configuration complete.');
console.log('═══════════════════════════════════════════════════════════════');
console.log();
console.log('Next steps (wire into the Worker):');
console.log();
console.log('1. Add to wrangler.jsonc env.staging.vars:');
console.log();
for (const [envName, priceId] of Object.entries(priceIds)) {
  console.log(`     "${envName}": "${priceId}",`);
}
console.log(`     "STRIPE_PORTAL_CONFIG_ID": "${portalConfig.id}",`);
console.log(`     "BILLING_ENABLED": "true"`);
console.log();
console.log('2. Set Worker secrets on staging:');
console.log();
console.log('     wrangler secret put STRIPE_SECRET_KEY --env staging');
console.log('     # paste your sk_test_… key');
console.log();
if (signingSecret) {
  console.log('     wrangler secret put STRIPE_WEBHOOK_SIGNING_SECRET --env staging');
  console.log(`     # paste: ${signingSecret}`);
} else {
  console.log('     (webhook signing secret already set, or re-run with --rotate-webhook to rotate)');
}
console.log();
console.log('3. Append to .dev.vars (for local dev):');
console.log();
if (signingSecret) {
  console.log(`     STRIPE_WEBHOOK_SIGNING_SECRET=${signingSecret}`);
} else {
  console.log('     STRIPE_WEBHOOK_SIGNING_SECRET=<already set; rerun with --rotate-webhook to rotate>');
}
console.log();
console.log('4. Append to .env (frontend):');
console.log('     VITE_BILLING_ENABLED=true');
console.log();
