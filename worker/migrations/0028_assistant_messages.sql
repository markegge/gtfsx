-- "Ask GTFS·X" help-assistant telemetry (issue #68).
--
-- One row per completed assistant exchange. Doubles as a feature-demand signal:
--   - answer_class = 'not_supported' rows are logged, user-phrased feature needs
--     (whether or not the user then filed the forum feature request).
--   - answered exchanges with docs_cited = 0 flag docs/recipe gaps (feeds #53).
--
-- Deliberately does NOT store the model's answer text — only the user's question
-- (capped) and structured metadata. Keeps the table cheap and avoids persisting
-- generated prose. project_id is nullable (assistant is usable without a feed open).
CREATE TABLE IF NOT EXISTS assistant_messages (
  id             TEXT PRIMARY KEY,          -- ulid
  user_id        TEXT NOT NULL,
  project_id     TEXT,                      -- feed/project id if one was open; else NULL
  question       TEXT NOT NULL,             -- the user's question (truncated server-side)
  answer_class   TEXT NOT NULL,             -- 'supported' | 'workaround' | 'not_supported'
  tools_called   TEXT NOT NULL DEFAULT '[]',-- JSON array of tool names surfaced (open_panel/link_docs/suggest_feature_request)
  docs_cited     INTEGER NOT NULL DEFAULT 0,-- count of link_docs citations in the answer
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL           -- ms epoch
);

-- Demand-ranking + gap queries scan by class and recency.
CREATE INDEX IF NOT EXISTS idx_assistant_messages_class_created
  ON assistant_messages (answer_class, created_at);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_user_created
  ON assistant_messages (user_id, created_at);
