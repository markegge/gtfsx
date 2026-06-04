-- Phase 7 (#34): per-embed impression counters.
--
-- Privacy-respecting aggregate counter — there is NO per-view row, no IP, no
-- User-Agent, no session id, no user id. We store only a running daily count
-- per (project, embed kind, optional target). That's enough to answer "how
-- many times was this feed's stop/route/system embed viewed" for the owner,
-- and nothing that could identify a rider.
--
-- Counting is driven by a tiny beacon (feeds.*/<slug>/embed/beacon) that the
-- edge-cached embed HTML pings client-side, so impression counting never
-- defeats the embed's edge cache: the HTML is cached, the 1x1 beacon is not.

CREATE TABLE embed_impression (
  project_id  TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  kind        TEXT NOT NULL,                 -- 'system-map' | 'route' | 'stop' | 'schedule' | 'landing'
  target      TEXT NOT NULL DEFAULT '',      -- route_id / stop_id, or '' for whole-feed kinds
  views       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, kind, target)
);

-- Owner rollups query by project (+ date range); the PK already orders by day
-- within a project, but an explicit index keeps "recent days across all kinds"
-- fast as the table grows.
CREATE INDEX embed_impression_project_day_idx ON embed_impression (project_id, day);
