# GTFS·X — Freemium Implementation Plan

*Status: 🔲 planned. Source of truth for the freemium / paid-tier work. Companion to [`REQUIREMENTS.md`](./REQUIREMENTS.md) and [`BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md).*

> **May 2026 pricing v2:** Display rename Team → **Agency**. The internal plan
> id was renamed `team` → `agency` to match (migration `0017`); only the Stripe
> env-var names (`STRIPE_PRICE_TEAM_*`), product id (`gtfsb_team`), and price
> lookup keys keep the old word for stability. Agency monthly price moved
> $199 → $299 and annual $1,999 → $2,499. `analysis_basic` (cost + coverage)
> moved up from Pro to Agency-and-up to position the Agency tier head-to-head
> against Remix's planning suite. Implementation details + open Stripe/migration
> follow-ups in [`PRICING_RESTRUCTURE.md`](./PRICING_RESTRUCTURE.md).

This document defines what needs to be built to turn the current backend (auth, orgs, projects, publication, embeds — see [`BACKEND_STATUS.md`](./BACKEND_STATUS.md)) into a monetised product with a free tier and paid plans. Strategic context lives in the business plan at `~/Library/CloudStorage/.../GTFS·X/Business Plan.md` — the short version is: undercut Remix/Trillium on price *and* on procurement friction, free editor + self-hosted export, managed publishing is the paywall, analysis features are the second paywall, Enterprise covers state DOTs / RTAP / Cal-ITP.

---

## 0. Scope & non-goals

**In scope (v1 freemium launch):**

- A `plan` model on users and orgs (Free / Pro / Team / Consultant / Enterprise) with per-tier quotas and feature flags.
- Stripe integration: Customers, Subscriptions, customer portal, webhooks. Card-payment self-serve for Pro / Team / Consultant.
- Managed publishing as the primary paywall. Self-hosted GTFS ZIP export stays free forever.
- Analysis features (Title VI, demographic coverage, cost estimation) gated to paid tiers.
- Consultant tier (solo) — subscription on the user; cross-org member capability (org memberships already exist; just need the SKU + billing).
- Consultant Firm tier — subscription on an org with per-seat billing; members inherit Consultant capability. Same $79/seat/mo price as solo Consultant.
- Enterprise tier — manually provisioned by staff console, monthly/annual invoice via Stripe or off-platform.
- Frontend: pricing page at `/pricing`, billing settings under `/account`, paywall modals, upgrade flows.
- Pre-launch migration of the 4 existing prod accounts (grandfathered to Free or — for `mark@eateggs.com` — Enterprise/staff).

**Out of scope for v1 (deferred):**

- Discourse-hosted community message board (separate ops task; community.gtfsx.com subdomain).
- Per-project membership inside an org (BE-95) — still future as in the existing spec.
- Custom domains for published feeds (BE-77 area) — still not supported.
- Real-time multi-cursor collaboration.
- Per-call API rate limit billing.
- Annual prepayment discounts beyond a flat 2-month-free annual price (already in the published tiers).
- A separate non-profit / educational pricing tier. **Decision:** not offered, not even case-by-case. Universities and advocacy orgs purchase at standard rates. Revisit only if there's a strategic reason (e.g., a research partnership).

**Hard constraints:**

- The existing kill-switch (`BACKEND_ENABLED` worker var + `VITE_BACKEND_ENABLED` frontend flag) must remain functional throughout. Launching freemium is a *prerequisite* for re-enabling backend on production, not the same release.
- Argon2id password hashing (NF-40a from `BACKEND_REQUIREMENTS.md` §8.1) lands **before** the freemium launch, not after. Open public signup is when PBKDF2 → argon2id matters.
- No breaking changes to feed import/export or to the anonymous IndexedDB editor flow. Free users today (no account) should remain unaffected.

---

## 1. Tier model

| Tier | Price | Feeds (saved) | Managed publishing | Analysis | Orgs / collaboration | Support |
|---|---|---|---|---|---|---|
| **Anonymous** (no account) | $0 | 0 (local IndexedDB only) | None | None | None | Community board |
| **Free** (account) | $0 | Up to 3 | None — self-hosted ZIP export only | None | Personal workspace only | Community board |
| **Pro** | $49/mo or $499/yr | Up to 10 | 1 feed | None (moved to Agency in v2) | Personal workspace only | Email (best-effort) |
| **Agency** (DB id: `agency`) | $299/mo or $2,499/yr | Unlimited | Up to 5 feeds | Full: demographic coverage, cost estimation, stop analysis, Title VI, propensity heatmap | One org with unlimited seats | Email (1-2 BD target) |
| **Consultant (solo)** | $79/mo or $790/yr per seat | Unlimited | Up to 5 feeds per seat | Full | Member of unlimited orgs (cross-org access) | Email (1-2 BD target) |
| **Consultant Firm** | $79/mo or $790/yr × N seats | Unlimited | Up to 5 feeds per seat | Full | Firm org; each member can join unlimited external client orgs | Email (1-2 BD target) |
| **Enterprise** | $25k-150k/yr (custom) | Unlimited under license | Unlimited, branded | Full + custom | Unlimited orgs + agencies under license | Phone + email with SLA |

Annual prices = ~10× monthly (2 months free). Display monthly price prominently with annual toggle on the pricing page.

### 1.1 Feature matrix — what each tier sees

| Feature | Anon | Free | Pro | Agency | Consultant | Enterprise |
|---|---|---|---|---|---|---|
| Map + form editor | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Save feeds in cloud | — | ✅ (3) | ✅ (10) | ✅ (∞) | ✅ (∞) | ✅ (∞) |
| Local IndexedDB editor | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GTFS ZIP export (self-host) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Draft share links | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Managed publishing (canonical) | — | — | 1 | 5 | 5/seat | ∞ |
| Mobility Database submission | — | — | ✅ | ✅ | ✅ | ✅ |
| Rider-facing embeds + mini-site | — | — | ✅ | ✅ | ✅ | ✅ |
| GTFS-Flex authoring | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Demographic coverage analysis | — | — | — | ✅ | ✅ | ✅ |
| Cost estimation analysis | — | — | — | ✅ | ✅ | ✅ |
| Stop analysis (spacing, balancing, service intensity, accessibility) | — | — | — | ✅ | ✅ | ✅ |
| Title VI equity analysis | — | — | — | ✅ | ✅ | ✅ |
| Propensity heatmap | — | — | — | ✅ | ✅ | ✅ |
| Org workspace (multi-user) | — | — | — | ✅ | ✅ (as member) | ✅ |
| Cross-org membership | — | — | — | — | ✅ | ✅ |
| Custom brand color | — | — | ✅ | ✅ | ✅ | ✅ |
| Custom org logo | — | — | — | ✅ | ✅ | ✅ |
| Phone support + SLA | — | — | — | — | — | ✅ |

**Key rules:**

- The free editor (anonymous IndexedDB) is preserved as a separate path. It is not a "tier" so much as a fallback; sign-up converts the local feed to a Free account feed.
- "Cloud-saved feed" = `feed_project` row in D1 + R2 working state blob. The free tier limits the count of these per owner.
- Managed publishing = creating a `publication` row pointing at a `feed_snapshot`, which makes `feeds.*/<slug>/gtfs.zip` resolve to the snapshot's rendered ZIP and exposes embeds at `feeds.*/<slug>/`. Free tier never gets a `publication` row.
- "Self-hosted" publishing means: download the ZIP via export, host wherever (state DOT clearinghouse, GitHub Pages, own server, Mobility Database direct upload). The editor and exporter make no distinction.

---

## 2. Data model

New migration `0006_billing.sql`. Additions only; no destructive changes.

### 2.1 Schema

```sql
-- 0006_billing.sql

-- Plan assignment on users and orgs.
ALTER TABLE user
  ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
  -- 'free' | 'pro' | 'consultant' — for personal-owner billing
ALTER TABLE user
  ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE user
  ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
  -- 'active' | 'past_due' | 'canceled' | 'trialing'
ALTER TABLE user
  ADD COLUMN plan_renewal_at INTEGER;
  -- unix ms; null on free
ALTER TABLE user
  ADD COLUMN plan_seat_count INTEGER NOT NULL DEFAULT 1;
  -- for consultant: number of paid seats

ALTER TABLE organization
  ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
  -- 'free' | 'agency' | 'enterprise' — for org-owned billing (the historical
  -- 'consultant_firm' value was folded into the Agency tier by migration 0009)
ALTER TABLE organization
  ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE organization
  ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organization
  ADD COLUMN plan_renewal_at INTEGER;
ALTER TABLE organization
  ADD COLUMN plan_seat_count INTEGER NOT NULL DEFAULT 1;
  -- for agency: number of paid seats

-- One subscription per billing owner (user or org).
CREATE TABLE subscription (
  id                       TEXT PRIMARY KEY,           -- ULID
  owner_type               TEXT NOT NULL,              -- 'user' | 'organization'
  owner_id                 TEXT NOT NULL,
  stripe_subscription_id   TEXT NOT NULL UNIQUE,
  stripe_customer_id       TEXT NOT NULL,
  stripe_price_id          TEXT NOT NULL,              -- which Price object
  plan                     TEXT NOT NULL,              -- mirrors user.plan / org.plan
  status                   TEXT NOT NULL,              -- mirrors Stripe subscription.status
  quantity                 INTEGER NOT NULL DEFAULT 1, -- seats
  current_period_start     INTEGER NOT NULL,
  current_period_end       INTEGER NOT NULL,
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0,
  canceled_at              INTEGER,
  trial_end                INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX subscription_owner_idx ON subscription (owner_type, owner_id);
CREATE INDEX subscription_status_idx ON subscription (status);

-- Stripe webhook event log for idempotency.
CREATE TABLE stripe_event (
  id            TEXT PRIMARY KEY,            -- evt_xxx from Stripe
  type          TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,               -- sha256 of raw body, for tamper detection
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER
);

CREATE INDEX stripe_event_type_idx ON stripe_event (type);
CREATE INDEX stripe_event_unprocessed_idx ON stripe_event (processed_at) WHERE processed_at IS NULL;

-- Track which user / org last initiated a Stripe Checkout session, for
-- correlating the eventual webhook back to a billing owner before subscription
-- records exist.
CREATE TABLE checkout_session (
  id                  TEXT PRIMARY KEY,        -- cs_xxx from Stripe
  owner_type          TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  target_plan         TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  initiated_by_user   TEXT NOT NULL REFERENCES user(id),
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  expired_at          INTEGER
);

CREATE INDEX checkout_session_owner_idx ON checkout_session (owner_type, owner_id);
```

### 2.2 Why a separate `subscription` table when plan already lives on user/org

The user/org `plan` column is the cached current state — fast to read on every request, easy to gate on. The `subscription` table is the source of truth synced from Stripe webhooks and supports past-due states, grace periods, plan changes mid-cycle, and the audit trail of "when did this customer change from Pro to Team."

Reconciliation rule: when a Stripe webhook updates `subscription`, also UPDATE the cached `plan` on user/org in the same D1 batch. The cached fields are derived; the subscription row is authoritative.

### 2.3 Migrations to existing data

On first deploy of migration `0006`:

- All existing `user` rows get `plan='free'`, `plan_status='active'`. The 4 existing prod accounts are grandfathered to Free.
- `mark@eateggs.com` is upgraded to Enterprise manually via the staff console (or `wrangler d1 execute --command "UPDATE user SET plan='enterprise' WHERE email='mark@eateggs.com'"`) before launch.
- All existing `organization` rows get `plan='free'`.
- No data is removed. The grace period for existing users to upgrade or hit the 3-feed limit is 30 days from public launch, communicated by email.

---

## 3. Stripe integration

### 3.1 Stripe object model

In the Stripe dashboard, configure:

- **Products** (5): `gtfs-builder-pro`, `gtfs-builder-team`, `gtfs-builder-consultant` (solo + firm share the same Product; firm distinguished by org-attached customer record and quantity), `gtfs-builder-enterprise`. Enterprise has no public price; it's invoice-only.
- **Prices** per product (2 each — monthly, annual). Annual = 10× monthly. Consultant is `per_unit` recurring with quantity = seats.

Example Price IDs (assigned at Stripe creation, stored as Worker vars):

```
STRIPE_PRICE_PRO_MONTHLY      = price_xxx
STRIPE_PRICE_PRO_ANNUAL       = price_xxx
STRIPE_PRICE_TEAM_MONTHLY     = price_xxx
STRIPE_PRICE_TEAM_ANNUAL      = price_xxx
STRIPE_PRICE_CONSULTANT_MONTHLY = price_xxx
STRIPE_PRICE_CONSULTANT_ANNUAL  = price_xxx
```

### 3.2 Secrets and env vars (added to `wrangler.jsonc`)

```jsonc
{
  // ...existing vars...
  "vars": {
    "BACKEND_ENABLED": "true",
    "BILLING_ENABLED": "false",  // independent kill-switch for the billing path
    // ... price IDs as above ...
  }
}
```

Worker secrets:

```
STRIPE_SECRET_KEY            // sk_live_xxx or sk_test_xxx
STRIPE_WEBHOOK_SIGNING_SECRET // whsec_xxx
```

Frontend env:

```
VITE_STRIPE_PUBLISHABLE_KEY  // pk_live_xxx (loaded by stripe.js)
VITE_BILLING_ENABLED         // mirrors BILLING_ENABLED to gate UI
```

### 3.3 Stripe Checkout flow

1. User on `/pricing` clicks "Upgrade to Pro." Frontend calls `POST /api/billing/checkout` with `{ plan: 'pro', interval: 'monthly', owner_type: 'user', owner_id: <self> }`.
2. Worker creates Stripe Customer if user doesn't yet have one, creates a Checkout Session with `mode='subscription'`, success/cancel URLs pointing back at the app, and a `metadata` field carrying `owner_type`, `owner_id`, `target_plan`. Writes a `checkout_session` row.
3. Worker returns `{ url }`; frontend redirects.
4. User completes payment on Stripe-hosted checkout. Stripe redirects to `/account/billing?session_id=...`.
5. In parallel, Stripe fires `checkout.session.completed` and `customer.subscription.created` webhooks. Webhook handler creates the `subscription` row and updates `user.plan`.
6. Frontend on `/account/billing` polls `GET /api/billing/me` until the plan reflects the upgrade (max 30s) or shows a "processing" state.

### 3.4 Customer portal

For self-serve billing management (update card, cancel, change plan, download invoices):

- `POST /api/billing/portal` — creates a Stripe Billing Portal session for the current user (or org admin), returns the redirect URL.
- Configure the portal in Stripe dashboard to enable: plan switching between same-product intervals (monthly ↔ annual), cancellation with end-of-period, payment method updates, invoice history.
- Cross-plan switching (Pro → Team) is **not** done via portal in v1; it goes through a Checkout flow because it changes the Product. (Stripe portal supports this but cross-product upgrades have a UX gotcha — handle via Checkout to control proration messaging.)

### 3.5 Webhook handler

`POST /api/billing/webhooks/stripe` — receives Stripe events. Signature verification using `STRIPE_WEBHOOK_SIGNING_SECRET`. Idempotency via `stripe_event` table (insert with `id` PK; if duplicate, return 200 immediately).

Events to handle:

| Event | Action |
|---|---|
| `checkout.session.completed` | Mark `checkout_session.completed_at`; create/update `subscription` row from the included subscription object; update cached `plan` on owner. |
| `customer.subscription.created` | Insert `subscription` row if not already present; sync plan. |
| `customer.subscription.updated` | Update `subscription` row (status, period dates, quantity, cancel_at_period_end); sync plan. |
| `customer.subscription.deleted` | Mark `subscription.status='canceled'`; downgrade owner plan to 'free' at period end if not already. |
| `invoice.paid` | Update `current_period_end` on subscription. Audit log entry. |
| `invoice.payment_failed` | Set `plan_status='past_due'` on owner. Send email. |
| `customer.subscription.trial_will_end` | (Future, if we add trials.) Send a heads-up email. |

All handlers are idempotent — replaying any event must produce the same end state.

### 3.6 Tax and compliance

- Stripe Tax enabled at the account level from day 1 (decided §9.5). Tax IDs collected at checkout via Stripe's built-in collection. Handles US sales tax + international VAT/GST automatically.
- Receipts and invoices generated by Stripe; no custom invoice rendering needed for self-serve tiers.
- For Enterprise customers, invoices issued via Stripe's "Send invoice" flow (manual) or off-platform PO process. The `subscription` row is still created so the rest of the gating logic works.
- For non-US customers, defer until first inbound demand. Stripe handles the mechanics; we just need to confirm we are willing to support international agencies (probably yes for CA/EU/AU consultants and agencies; case-by-case for others).

---

## 4. Backend API surface (additions)

### 4.1 Billing endpoints (editor origin, auth-gated)

```
GET    /api/billing/me                    → { plan, plan_status, plan_renewal_at, seat_count }
GET    /api/billing/plans                 → catalog of price IDs + amounts (public, used by /pricing)
POST   /api/billing/checkout              → start a Stripe Checkout Session for a target plan
POST   /api/billing/portal                → open the customer portal for the current owner
POST   /api/billing/webhooks/stripe       → Stripe webhook receiver (no auth, verified by signature)
GET    /api/orgs/:id/billing              → org-scoped equivalent of /billing/me (admin+ on the org)
POST   /api/orgs/:id/billing/checkout     → org admin starts checkout for a Team plan
POST   /api/orgs/:id/billing/portal       → org admin opens portal
```

### 4.2 Quota/plan middleware

`worker/billing/middleware.ts` exports `requirePlan(plans: Plan[])` and `requireFeature(feature: FeatureKey)`. These read the cached `plan` from the authenticated user (or, for org-scoped requests, the org's plan) and return a 402 Payment Required with a structured body if access is denied.

Mounted ahead of:

- `POST /api/projects/:id/publish` — `requireFeature('managed_publishing')`
- `POST /api/projects/:id/embeds/*` — same
- `GET  /api/projects/:id/analysis/title-vi` — `requireFeature('title_vi')`
- `GET  /api/projects/:id/analysis/coverage` — `requireFeature('analysis_basic')`
- `GET  /api/projects/:id/analysis/cost-estimate` — `requireFeature('analysis_basic')`

Analysis features today run client-side. The gating point is the API endpoints that supply the demographic data (Census block-group fetches go through the worker as a CORS-friendly proxy + cache). The worker is where the gate lives. Pure client-side recomputation against in-memory data is allowed for the free tier; only the analysis tabs that fetch reference data are gated.

### 4.3 Updated quotas

`worker/projects/quotas.ts` becomes plan-aware:

```ts
export const PLAN_QUOTAS = {
  free:             { projects: 3,     versions_per_project: 5,   blob_bytes: 20 * 1024 * 1024,  published_feeds: 0 },
  pro:              { projects: 10,    versions_per_project: 25,  blob_bytes: 50 * 1024 * 1024,  published_feeds: 1 },
  agency:           { projects: 500,   versions_per_project: 50,  blob_bytes: 100 * 1024 * 1024, published_feeds: 5 },
  consultant:       { projects: 500,   versions_per_project: 50,  blob_bytes: 100 * 1024 * 1024, published_feeds: 5 },     // solo
  consultant_firm:  { projects: 500,   versions_per_project: 50,  blob_bytes: 100 * 1024 * 1024, published_feeds: 5 },     // shared at org; per-seat scaling tracked separately
  enterprise:       { projects: 99999, versions_per_project: 200, blob_bytes: 200 * 1024 * 1024, published_feeds: 99999 },
} as const;
```

`countProjects` and `countVersions` stay the same. Add `countPublishedFeeds(env, ownerType, ownerId)` and check it in `POST /api/projects/:id/publish`. The 30-day "soft" warning behaviour (current `HARD_LIMITS=false` mode) stays for the free tier *only* — paid plans should hard-block at limit and prompt to upgrade. Add a third mode beyond hard/soft: `paid_hard` (paid plans hard-block, free plans soft-warn through their 3-feed limit but hard-block at 4th).

### 4.4 Consultant cross-org access

`organization_membership` already supports many-to-many. The only new constraints:

- A Consultant-plan user can be added as a member to unlimited orgs.
- A Pro-plan user can only be a member of orgs they own (org count = 0, since Pro doesn't include an org).
- A Free-plan user cannot be a member of any org. (If invited, they must upgrade to Pro/Consultant or the inviting org must add a seat for them.)
- A Team-plan org has up to 10 seats. Adding an 11th seat prompts the org owner to upgrade quantity.
- A Consultant Firm org has seats = `plan_seat_count`. Adding the (N+1)th member prompts the owner to increase quantity via Stripe (the same checkout flow re-runs with the new quantity).

Enforced at the `POST /api/orgs/:id/invitations` and `POST /api/orgs/:id/members` endpoints by a new `requireSeatAvailable` check that compares `COUNT(memberships)` against `org.plan_seat_count`.

### 4.5 Enterprise SKU mechanics

Enterprise is invoice-driven, not self-serve. Staff console adds:

- `POST /api/admin/orgs/:id/enterprise-grant` — staff-only, sets `org.plan='enterprise'`, no Stripe Subscription needed. Optional `expires_at` timestamp (annual contract end).
- `POST /api/admin/users/:id/enterprise-grant` — same for a personal-owner Enterprise (rare, but supported).

A nightly cron checks `plan_renewal_at` on enterprise grants and downgrades to Free if expired without renewal, with a 14-day prior email warning.

---

## 5. Frontend changes

### 5.1 New routes

| Route | Purpose |
|---|---|
| `/pricing` | Public marketing page with the tier comparison, FAQ, upgrade buttons. Available even when backend is disabled (shows "join the waitlist" CTA in that state). |
| `/account/billing` | Logged-in: current plan, renewal date, seats, manage-via-portal button, plan-switch button. |
| `/orgs/:id/billing` | Org admins: same for the org. |
| `/upgrade` | Lightweight upgrade flow — modal route, accessible from paywalled features. Pre-selects the smallest plan that unlocks the requested feature. |

### 5.2 New components

- `<PaywallOverlay feature={...} />` — wraps a gated UI region. If the user lacks access, dims the content and shows an upgrade CTA. Used on Title VI tab, propensity heatmap layer, publish button, embed code panel.
- `<UpgradeButton plan={...} />` — initiates the Checkout flow.
- `<PlanBadge plan={...} />` — shows the user's current plan in the workspace switcher and account header.
- `<SeatPicker />` — for Consultant signup, picks 1-N seats; price updates live.
- `<UsageMeter quota={...} used={...} />` — shows feeds-used / managed-publishes-used in the account billing page and as a top-bar warning when near limit.

### 5.3 Paywall placement (UI inventory)

| Surface | Behaviour |
|---|---|
| Publish button on `/feeds/:slug` | Free: button disabled with "Upgrade to publish" tooltip + click opens upgrade modal. Pro/Team/Consultant/Enterprise: enabled within quota; at quota shows "Publish limit reached." |
| Embed code panel | Free: hidden. Paid: visible. |
| Title VI tab | Free + Pro: tab visible, shows paywall overlay with summary of what the analysis would tell them. Team+: full functionality. |
| Propensity heatmap layer toggle | Same pattern as Title VI. |
| Demographic coverage tab | Free: paywall overlay. Pro+: full. |
| Cost estimation tab | Free: paywall overlay. Pro+: full. |
| Brand color picker | Free: paywall overlay. Pro+: full. |
| Org logo upload | Free + Pro: hidden (Pro doesn't get orgs). Team+: full. |
| 4th feed creation | Free hits hard limit, shows "Upgrade to save more feeds." |

### 5.4 Conversion flow design

- Paywalled CTA is always a single click away from completing checkout. The CTA writes the user's intent (which feature they want) into the upgrade modal so the modal can lead with the cheapest plan that unlocks it.
- ~~Trials: don't add trials in v1.~~ **Reversed May 2026.** Agency now ships with a 14-day trial, card up front. Pro stays no-trial — its value is testable in an hour on the Free tier already. Rationale: Agency's planning-suite features (cost, coverage, Title VI, propensity) can't be evaluated on Free at all, and the $299/mo price point needs a no-commitment evaluation path to compete with Remix on the small-agency demand we're targeting via Google Ads. Implementation: `subscription_data.trial_period_days: 14` on Agency checkout sessions; `customer.subscription.trial_will_end` webhook fires the T-3 reminder email; Stripe enforces one trial per customer.
- Annual vs monthly: default toggle to monthly; show "Save with annual" hint.
- Show "Free trial" badge on Agency tier on the pricing page (was "Most popular", then briefly "Best value", landed on "Free trial" with the May 2026 trial launch).
- Have a discreet "Looking for an Enterprise plan?" link at the bottom of the pricing page that opens a mailto: with a prefilled subject. No public Enterprise pricing.

### 5.5 Existing UI changes

- Workspace switcher (top bar) shows the org's plan badge.
- Account dropdown adds "Billing" item.
- Right rail's project list shows feeds-used/quota for the current workspace.
- Sign-up flow doesn't change. New accounts default to Free. The first time a Free user hits a limit, they're nudged to upgrade.

---

## 6. Managed publishing as the paywall — implementation detail

This is the operationally important piece. The free tier must be able to export a GTFS ZIP and host it anywhere, but not get a `feeds.gtfsx.com/<slug>/gtfs.zip` URL.

**Concrete enforcement points:**

1. The `POST /api/projects/:id/publish` endpoint already exists. Add a `requireFeature('managed_publishing')` middleware in front. Free users get a 402 with a structured upgrade-CTA payload.
2. Self-hosted export (`POST /api/projects/:id/export` returning a ZIP for download, plus the client-side ZIP generation path) stays open to all signed-in users. Anonymous users still get their browser-only export.
3. Mobility Database submission (`worker/distribution/mobility_database.ts`) is only callable after a publication exists, so it's gated transitively.
4. Draft links (`feeds.*/<slug>/draft/<token>.zip`) — these *do* go through the FEEDS origin and create a public URL. Decision: keep draft links available to Pro+ only, not Free. A free user who wants to share a feed can still export the ZIP and email it. Reasoning: draft links cost us R2 hosting, are hard to expire defensively, and they're effectively "managed publishing with one user." Keeping them paid keeps the paywall coherent.
5. Existing `BE-50/51` R2 storage layout doesn't change. The publication path's R2 read just gets a 402 instead of returning bytes when no publication exists for a free project.

**Quota wording for the user:**

- "Save up to 3 feeds in the cloud" (free)
- "Publish 1 feed to a stable URL" (pro)
- "Publish up to 5 feeds with full embeds and a mini-site" (team)

Avoid jargon like "managed publishing" in customer-facing copy — call it "Publish to a stable URL" or "Publish your feed to a public URL."

---

## 7. Consultant tier specifics (solo + firm)

The Consultant SKU exists because consultants build feeds for many clients and shouldn't pay Team prices for each client org separately. Two variants in v1 — solo (subscription on a user) and firm (subscription on an org with per-seat billing). Both grant the same capability: cross-org membership without consuming seats from the client org's plan.

**Solo Consultant** (subscription on a `user`):

- `user.plan='consultant'`, billing on the individual.
- The user can be a member (with editor or admin role) of unlimited orgs.
- When a Consultant user is invited to an org, the org doesn't consume a seat from its Team plan. (If the org doesn't have Team, no seat is consumed because Free orgs allow only their owner.)
- The user owns feeds in their personal workspace AND can create/edit feeds in client orgs they've been added to.

**Consultant Firm** (subscription on an `organization`):

- `org.plan='consultant_firm'`, billing on the org with `quantity = N seats`.
- Each member of the firm org inherits the Consultant capability (cross-org membership without consuming external-org seats).
- The firm org has its own workspace where the firm's shared feeds live (template feeds, internal experiments, work product before handoff).
- Firm members can also have personal-workspace feeds; those are not billable separately (the firm seat covers personal-workspace access).
- Adding a member to the firm org consumes one seat. Adding the (N+1)th member prompts the firm owner to increase quantity.
- Removing a member returns a seat to the pool.
- Pricing: $79/seat/mo, same as solo. No firm discount in v1 — the firm SKU is a billing convenience, not a discount tier.

**Conversion / disambiguation:**

- New signup defaults to Free. To become a Consultant, the user clicks "Upgrade" and picks Consultant.
- Selecting Consultant in the upgrade flow asks: "Are you billing as an individual or as a firm?" — individual → solo Consultant subscription on user; firm → prompt to name the firm org, picks initial seat count, creates the org with `plan='consultant_firm'` and the user as owner.
- A solo Consultant can later convert to a firm by creating a firm org and migrating the subscription (admin support flow in v1; self-serve in v1.1).
- Per-seat scaling has two paths, both in v1:
  - **Solo Consultant:** subscription on the `user`. `user.plan='consultant'`, `user.plan_seat_count=1`, billed $79/mo to the individual.
  - **Consultant Firm:** subscription on an `organization` with `org.plan='consultant_firm'`, `org.plan_seat_count=N`, billed $79/mo × N. Each member of the firm org inherits the Consultant capability — i.e., can be invited to unlimited *external* (client) orgs without consuming a seat from those orgs' plans. Price per seat is the same as solo to keep mental model simple; no firm discount in v1.
- Identifying a Consultant: a flag on signup OR a checkbox during the upgrade flow OR derived from "are you a member of an org you don't own?" Make it a checkbox on the upgrade-to-Consultant CTA.

Open question: does the Consultant tier need to be self-attested? Self-attestation is the only practical mechanism for differentiating Pro vs. Consultant at signup, but the price differential ($19 vs. $79) means people will pick Pro and then ask to be added to client orgs. **Decision:** invite-to-org from an org with `plan != 'free'` requires the invitee to be Pro+. Trying to be added to an org as a Free user surfaces an "Upgrade to accept this invitation" CTA. This makes Consultant the natural choice for anyone working across multiple orgs without needing to enforce it on signup.

---

## 8. Launch checklist

In order.

### 8.1 Pre-launch (code work, no user-visible change)

1. Land NF-40a (argon2id) — separate ticket, prerequisite per `BACKEND_STATUS.md`.
2. Apply migration 0006 to staging D1. Verify existing 4 users + 2 demo orgs default to Free.
3. Configure Stripe test mode account, create Products and Prices, store IDs in `wrangler.jsonc` for staging.
4. Implement the worker billing module (`worker/billing/`):
   - `routes.ts` — the API surface in §4.1
   - `stripe.ts` — Stripe API client (use `stripe` npm package; works in workerd)
   - `webhooks.ts` — webhook receiver + dispatcher
   - `quotas.ts` — replaces `worker/projects/quotas.ts` flat constants with the plan-aware table
   - `middleware.ts` — `requirePlan` and `requireFeature`
5. Implement frontend:
   - `/pricing` static page
   - `/account/billing` and `/orgs/:id/billing`
   - `<PaywallOverlay>` and apply to all gated surfaces (§5.3)
   - Upgrade modal and Checkout redirect
6. Tests:
   - Worker integration tests for every billing endpoint
   - Webhook idempotency test (replay 10× — state must be identical)
   - Feature gating tests for every paywall (free user hits 402, pro user passes, etc.)
   - Manual: full Stripe test-mode flow end-to-end on staging.

### 8.2 Staging soft launch

1. Flip `BILLING_ENABLED=true` on staging Worker.
2. Smoke-test all five paid tiers using Stripe test cards.
3. Verify Customer Portal flows.
4. Verify webhook delivery + retries.
5. Verify downgrade-at-period-end correctly converts feeds-over-quota into a soft-warn state without data loss.
6. Run a 1-2 week staging burn-in. Mark + at most 2-3 invited testers.

### 8.3 Production launch prerequisites

This is a **simultaneous launch** of backend re-enable + billing. Both `BACKEND_ENABLED` and `BILLING_ENABLED` flip to `true` in the same deploy. Compound risk vs. staged; mitigations below are non-negotiable.

1. Complete "Re-enable production checklist" in `BACKEND_STATUS.md` *except* the final flag flip. All prerequisites (argon2id, migrations 0004 + 0005, Turnstile secret, Resend sender verification) done.
2. Apply migration 0006 to prod D1.
3. Stripe live-mode account configured; Products and Prices in live mode; secrets rotated to live.
4. Webhook endpoint registered with Stripe pointing at prod `gtfsx.com`.
5. **Compound-risk mitigations (REQUIRED):**
   a. Staging burn-in of full backend + billing flow for minimum 2 weeks before prod flip. Zero P0/P1 bugs open at flip time.
   b. Rollback playbook written and rehearsed. Single-flag rollback: `BILLING_ENABLED=false` (leaves backend up but disables paid checkout/webhooks). Full rollback: both flags to `false`.
   c. Stripe webhook endpoint registered with manual-retry capability enabled, so a billing-side bug doesn't cause Stripe event loss.
   d. D1 migration 0006 has been applied and verified on staging with the same data shape (4 users, 2 demo orgs) before prod.
   e. Pre-launch DB backup of prod D1 (`wrangler d1 export gtfs-builder --remote --output prod-pre-launch-backup.sql`).
6. Email the 4 existing prod accounts about the launch and their grandfathered-Free status; give them 30 days to upgrade if over the 3-feed limit.
7. Public marketing announcement (separate workstream).

### 8.4 Production launch (simultaneous)

1. Apply migration 0006 to prod D1.
2. Promote staging build to prod with `BACKEND_ENABLED=true`, `VITE_BACKEND_ENABLED=true`, `BILLING_ENABLED=true`. Single `wrangler deploy --env=""` + frontend redeploy.
3. Verify within 10 minutes: signup works, login works, billing API responds, webhook endpoint reachable from Stripe dashboard.
4. Watch `wrangler tail` for first 24 hours. Watch for webhook failures, 402 responses, auth errors, signup→Free conversion rate.
5. Pre-write support templates for the first 10 likely tickets (refund request, downgrade, plan change, etc.).
6. Rollback decision criteria pre-defined: any data-integrity issue → full rollback immediately. Any billing-side bug without data-integrity impact → `BILLING_ENABLED=false` only, leave backend up.

### 8.5 Post-launch (first 90 days)

1. Weekly review of conversion metrics: signups → Pro/Team/Consultant rate, paywall click-to-upgrade rate per feature, churn.
2. Iterate on paywall copy and placement based on funnel data.
3. Consider Discourse community board if free-tier email support burden materializes (separate ops task; community.gtfsx.com).
4. Begin Cal-ITP and state DOT outreach for Enterprise — see business plan §9 next steps.

---

## 9. Decisions (resolved 2026-05-11)

These were the open questions; resolved with Mark before implementation.

1. **Pricing page default:** ✅ Monthly default, with annual toggle.
2. **Free-tier feed limit:** ✅ 3 feeds.
3. **Trials:** ✅ None.
4. **Consultant Firm SKU:** ✅ **In v1.** Same $79/seat/mo price as solo Consultant; no firm discount. Implementation details in §7.
5. **Stripe Tax:** ✅ Enabled day 1.
6. **Refund policy:** ✅ 30-day no-questions prorated refund on cancellation. After 30 days: cancellation stops future billing, no refund of current period.
7. **Educational / non-profit pricing:** ✅ Not offered. Standard pricing applies to all customer types. Revisit only for strategic partnerships.
8. **Launch sequencing:** ⚠️ **Simultaneous launch of prod backend re-enable + billing.** This was against the recommendation; Mark's call. Single coordinated flip of `BACKEND_ENABLED` and `BILLING_ENABLED` to `true` on prod. Compound-risk mitigations required (see §8.3.5).

---

## 10. Companion docs

- Business plan (strategy, market, pricing rationale): `~/Library/CloudStorage/GoogleDrive-mark@eateggs.com/My Drive/Vector & Vertex/GTFS·X/Business Plan.md`
- Existing requirements: [`REQUIREMENTS.md`](./REQUIREMENTS.md)
- Backend reference spec: [`BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md)
- Backend live state: [`BACKEND_STATUS.md`](./BACKEND_STATUS.md)
- Deploy runbook: [`DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md)
- Embeds spec: [`EMBEDS_REQUIREMENTS.md`](./EMBEDS_REQUIREMENTS.md)
- Workflow: [`WORKFLOW.md`](./WORKFLOW.md)
