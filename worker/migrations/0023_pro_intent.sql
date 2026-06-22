-- 0023: pro-intent signals — the hottest warm-lead signal for founder outreach.
--
-- One row per time an authenticated free user reaches for a Pro-gated action
-- (publish, 4th saved feed, mini-site/embed, MobilityDatabase submit) or starts
-- Stripe checkout. Written server-side by POST /api/me/pro-intent so the
-- warm-cohort export (GET /api/admin/warm-cohort.csv) can rank accounts by
-- demonstrated willingness to pay. No cookies, no third-party analytics — our
-- own stack, consistent with the cookieless `event` table (which is
-- deliberately anonymous and therefore can't carry a per-account signal).
--
-- Append-only; multiple fires per user are expected and fine (no idempotency).

CREATE TABLE pro_intent (
  id        TEXT PRIMARY KEY,            -- ULID
  user_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,            -- unix ms
  action    TEXT NOT NULL,               -- 'publish_intent'|'feed_cap'|'mini_site'|'mdb_submit'|'checkout_started'
  source    TEXT                         -- optional short UI context
);
CREATE INDEX pro_intent_user_idx ON pro_intent (user_id, ts);
CREATE INDEX pro_intent_action_idx ON pro_intent (action, ts);
