-- Phase 9: collapse the Consultant tier into Team. The product change unified
-- consultant features (cross-org membership) into Team and dropped the solo
-- Consultant tier; Pro now carries the lone-operator price.
--
-- Pre-launch billing means there should be no real subscribers on these plans,
-- but this migration is cheap insurance against staging/test rows.

-- Solo Consultant subscribers (billed on the user record) had no equivalent
-- on the new ladder — they upgrade to Pro, which now covers the lone operator
-- price point.
UPDATE user SET plan = 'pro' WHERE plan = 'consultant';

-- Consultant Firm subscribers (billed on the org record) map to Team, which
-- now includes unlimited seats and cross-org membership.
UPDATE organization SET plan = 'team' WHERE plan IN ('consultant', 'consultant_firm');

-- Sync the subscription cache table so any stale subscription rows agree with
-- the new owner-side plan column. Status / Stripe IDs are preserved.
UPDATE subscription SET plan = 'pro' WHERE plan = 'consultant' AND owner_type = 'user';
UPDATE subscription SET plan = 'team' WHERE plan IN ('consultant', 'consultant_firm') AND owner_type = 'org';
