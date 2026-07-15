-- 0026: demo_leads — captured demo-request lead forms.
--
-- One row per submission of the /book-demo lead form (POST /api/demo-leads).
-- The form replaced the old GET /book-demo redirect: instead of bouncing the
-- click straight to the booking calendar, we now capture the lead's contact
-- details first, then offer the calendar. This table is the durable record of
-- who asked for a demo (the cookieless `event` table stays anonymous and can't
-- carry name/email).
--
-- The Google Ads `demo_request` conversion is still emitted from the same
-- submit (into `event`, gclid-stamped) so Offline Conversion Import is
-- unaffected — see worker/marketing/demoLead.ts.
--
-- Append-only; no idempotency (a visitor may legitimately submit twice).
-- Additive + idempotent (IF NOT EXISTS) so re-running the migration is safe.

CREATE TABLE IF NOT EXISTS demo_leads (
  id         TEXT PRIMARY KEY,            -- ULID
  created_at INTEGER NOT NULL,            -- unix ms
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  org        TEXT,                        -- agency / organization (optional)
  message    TEXT,                        -- "anything specific you want to see?" (optional)
  src        TEXT,                        -- marketing placement label (?src=)
  gclid      TEXT,                        -- Google Ads click id (?gclid=)
  ref        TEXT                         -- referrer captured client-side
);
CREATE INDEX IF NOT EXISTS demo_leads_created_idx ON demo_leads (created_at);
