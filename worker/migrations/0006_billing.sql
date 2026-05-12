-- Phase 6: freemium / paid plans. Stripe-backed subscription billing.
-- See docs/FREEMIUM_PLAN.md for the rationale and tier model.
--
-- The cached `plan` column on user/organization is the fast-read source for
-- request-time gating. The `subscription` table is the source of truth synced
-- from Stripe webhooks. Reconciliation rule: when a webhook updates a
-- subscription row, the cached plan on its owner is updated in the same batch.
--
-- This migration is additive only. Existing user/org rows default to plan='free'.

-- Plan assignment on users (personal-owner billing: Free / Pro / Consultant solo).
ALTER TABLE user ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE user ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE user ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
  -- 'active' | 'past_due' | 'canceled' | 'trialing'
ALTER TABLE user ADD COLUMN plan_renewal_at INTEGER;
  -- unix ms; null on free
ALTER TABLE user ADD COLUMN plan_seat_count INTEGER NOT NULL DEFAULT 1;
  -- consultant solo: paid seat count (always 1 in v1)
ALTER TABLE user ADD COLUMN plan_expires_at INTEGER;
  -- enterprise grants only: contract end; nightly cron downgrades on expiry

CREATE INDEX user_plan_idx ON user (plan);
CREATE INDEX user_stripe_customer_idx ON user (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Plan assignment on organizations (org-owned billing: Free / Team / Consultant Firm / Enterprise).
ALTER TABLE organization ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE organization ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE organization ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organization ADD COLUMN plan_renewal_at INTEGER;
ALTER TABLE organization ADD COLUMN plan_seat_count INTEGER NOT NULL DEFAULT 1;
  -- team / consultant_firm: paid seat count, drives Stripe quantity
ALTER TABLE organization ADD COLUMN plan_expires_at INTEGER;

CREATE INDEX organization_plan_idx ON organization (plan);
CREATE INDEX organization_stripe_customer_idx ON organization (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Source-of-truth subscription record, one per billing owner (user or org).
-- Synced from Stripe webhooks. The cached `plan` on user/organization is
-- derived from the most recent active subscription row.
CREATE TABLE subscription (
  id                       TEXT PRIMARY KEY,            -- ULID
  owner_type               TEXT NOT NULL,               -- 'user' | 'org' (matches feed_project convention)
  owner_id                 TEXT NOT NULL,
  stripe_subscription_id   TEXT NOT NULL UNIQUE,        -- sub_xxx
  stripe_customer_id       TEXT NOT NULL,               -- cus_xxx
  stripe_price_id          TEXT NOT NULL,               -- price_xxx
  plan                     TEXT NOT NULL,               -- mirrors user.plan / org.plan
  status                   TEXT NOT NULL,               -- mirrors Stripe subscription.status
  quantity                 INTEGER NOT NULL DEFAULT 1,  -- seats
  current_period_start     INTEGER NOT NULL,
  current_period_end       INTEGER NOT NULL,
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0,  -- 0|1
  canceled_at              INTEGER,
  trial_end                INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX subscription_owner_idx ON subscription (owner_type, owner_id);
CREATE INDEX subscription_status_idx ON subscription (status);
CREATE INDEX subscription_customer_idx ON subscription (stripe_customer_id);

-- Stripe webhook event log. Insert-only; idempotency comes from the PK
-- (Stripe's event id). Replaying a duplicate event short-circuits to 200.
CREATE TABLE stripe_event (
  id            TEXT PRIMARY KEY,            -- evt_xxx
  type          TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,               -- sha256(raw body) for tamper detection
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  error         TEXT                          -- last error message if processing failed
);

CREATE INDEX stripe_event_type_idx ON stripe_event (type);
CREATE INDEX stripe_event_unprocessed_idx ON stripe_event (processed_at) WHERE processed_at IS NULL;

-- Track Stripe Checkout sessions so a webhook can be correlated back to its
-- initiating user/org before the subscription row exists. Cleaned up by the
-- nightly reaper after `expired_at`.
CREATE TABLE checkout_session (
  id                  TEXT PRIMARY KEY,        -- cs_xxx
  owner_type          TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  target_plan         TEXT NOT NULL,
  target_interval     TEXT NOT NULL,           -- 'month' | 'year'
  quantity            INTEGER NOT NULL DEFAULT 1,
  initiated_by_user   TEXT NOT NULL REFERENCES user(id),
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  expired_at          INTEGER
);

CREATE INDEX checkout_session_owner_idx ON checkout_session (owner_type, owner_id);
CREATE INDEX checkout_session_unfinished_idx ON checkout_session (created_at) WHERE completed_at IS NULL AND expired_at IS NULL;
