-- 0025: persist the ID-stability acknowledgements on a scheduled publish.
--
-- The publish path has two advisory 409 gates the caller acknowledges and
-- retries with an ignore flag: `rt_breakage` (BE-88) and `agency_id_churn` (C2,
-- the NTD P-50 crosswalk). The cron that fires a scheduled publish has no user
-- to ask, so before this migration a scheduled publish that tripped either gate
-- simply FAILED at fire time — the user was asleep and had no way to have
-- acknowledged it in advance.
--
-- Fix: a scheduled publish targets a FIXED, immutable snapshot, so the diff is
-- computable when the user schedules it. POST /publish/schedule now runs the
-- SAME gates (worker/publication/idStability.ts → assertIdStable) and returns
-- the SAME 409s; the user acknowledges in the same modals; the acknowledgements
-- land in these columns, and the cron replays them into performPublish().
--
-- Fail-safe by design: the cron does NOT blanket-acknowledge. It passes only
-- what the user actually acked, and performPublish re-runs the gates against
-- the CURRENT publication. If someone published something else in between, the
-- baseline moved, un-acked churn can appear, and the schedule still fails with
-- the reason recorded on the row (status='failed', failure_reason).
--
-- ignore_warnings (validation errors) was already persisted in 0019.

ALTER TABLE scheduled_publish ADD COLUMN ignore_rt_breakage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_publish ADD COLUMN ignore_agency_churn INTEGER NOT NULL DEFAULT 0;

-- Reversible:
--   ALTER TABLE scheduled_publish DROP COLUMN ignore_rt_breakage;
--   ALTER TABLE scheduled_publish DROP COLUMN ignore_agency_churn;
