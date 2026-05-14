-- Phase 7: lightweight cookieless analytics.
--
-- One row per page view. `ref` is the inbound referral tag captured from
-- ?ref= on the first request of a browser session. `session_id` is a random
-- value held in sessionStorage (per-tab) — gives us a "visit" notion without
-- cookies or fingerprinting; cleared when the tab closes.
--
-- We intentionally store no IP, no User-Agent, no user id. Only what's needed
-- to answer "how many visits per ref over a date range."

CREATE TABLE event (
  id           TEXT PRIMARY KEY,             -- ULID
  ts           INTEGER NOT NULL,             -- unix ms
  kind         TEXT NOT NULL,                -- 'page_view' (room for more later)
  path         TEXT NOT NULL,                -- URL pathname (no query, no host)
  ref          TEXT,                         -- ?ref= value at session start; NULL = direct
  session_id   TEXT NOT NULL,                -- random per-tab session id
  country      TEXT                          -- ISO-3166-1 alpha-2 from CF-IPCountry
);

CREATE INDEX event_ts_idx ON event (ts);
CREATE INDEX event_ref_ts_idx ON event (ref, ts);
CREATE INDEX event_session_ts_idx ON event (session_id, ts);
