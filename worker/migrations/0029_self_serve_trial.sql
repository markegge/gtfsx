-- 0029: self-serve, no-credit-card Planner trial.
--
-- A 14-day trial of the Planner plan (internal id 'agency') that a user starts
-- in-app with ZERO Stripe involvement. It reuses the existing comp-grant
-- mechanism for the actual gating: starting a trial sets organization.plan =
-- 'agency' with plan_expires_at = trial end, and the nightly cron
-- (expireEnterpriseGrants) downgrades it back to 'free' at expiry exactly as it
-- does for comp grants. This migration adds only the ELIGIBILITY + lifecycle
-- markers the plan columns can't carry, because plan_expires_at is NULLed on
-- revert and so leaves no record that a trial ever happened.
--
-- Eligibility is one trial per ORG and one per USER (a user who already burned a
-- trial can't farm fresh orgs for more), so the marker lives on both tables.
--
-- Additive only. Existing rows get NULL (never trialed).

-- Org-scoped trial lifecycle. The trial elevates the ORG's plan (Planner is
-- always billed to an org), so the authoritative trial state lives here.
ALTER TABLE organization ADD COLUMN trial_started_at INTEGER;
  -- unix ms; set once when this org's trial begins. NON-NULL => org has used
  -- its one trial (persists after revert; the org is never eligible again).
ALTER TABLE organization ADD COLUMN trial_ends_at INTEGER;
  -- unix ms; == plan_expires_at at start. Distinguishes a trial-granted agency
  -- plan (trial_ends_at NOT NULL) from a comp-granted one (trial_ends_at NULL)
  -- and drives the "N days left" banner. Retained after revert as a marker.
ALTER TABLE organization ADD COLUMN trial_reminder_sent_at INTEGER;
  -- unix ms; set when the "trial ends in 3 days" email is sent, so the daily
  -- cron sends it at most once per trial.

-- Per-user eligibility marker. Does NOT change user.plan (the trial elevates the
-- org, not the user) — this only records that the user has consumed their one
-- self-serve trial, so they can't restart it on a different org.
ALTER TABLE user ADD COLUMN trial_started_at INTEGER;
  -- unix ms; NON-NULL => user has already used their one free trial.

-- Find orgs whose trial is expiring / needs a reminder without a full scan.
CREATE INDEX organization_trial_ends_idx
  ON organization (trial_ends_at)
  WHERE trial_ends_at IS NOT NULL;
