-- Rename the internal plan identifier 'team' -> 'agency'. The customer-facing
-- tier was renamed Team -> Agency in the May-2026 pricing v2, but only the
-- display name changed at the time; the persisted plan column still stored
-- 'team'. This migration brings the data in line with the code, which now
-- reads/writes 'agency'. It MUST land atomically with that code deploy so
-- existing Agency customers don't lose paid access in the gap.
--
-- Clean cutover: there is no read-time 'team'->'agency' fallback in code, so
-- this UPDATE is the single source of correctness. The plan columns have no
-- CHECK constraint (validation lives in code), so a plain UPDATE suffices.

UPDATE user         SET plan = 'agency' WHERE plan = 'team';
UPDATE organization SET plan = 'agency' WHERE plan = 'team';
UPDATE subscription SET plan = 'agency' WHERE plan = 'team';
