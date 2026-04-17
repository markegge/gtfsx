-- Phase 1: users, credentials, sessions, auth tokens, audit events.
-- Everything here is append-only or soft-delete; no destructive cascades.

CREATE TABLE user (
  id              TEXT PRIMARY KEY,           -- ULID
  email           TEXT NOT NULL UNIQUE,       -- lowercased, trimmed
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending_verification',
                  -- pending_verification | active | disabled | deleted_soft
  staff           INTEGER NOT NULL DEFAULT 0,  -- 0|1 — operators-only support access
  created_at      INTEGER NOT NULL,            -- unix ms
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER                      -- soft-delete timestamp
);

CREATE INDEX user_deleted_at_idx ON user (deleted_at) WHERE deleted_at IS NOT NULL;

-- Auth material. A user can have multiple credentials (password + OAuth).
CREATE TABLE credential (
  id              TEXT PRIMARY KEY,           -- ULID
  user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,               -- 'password' | 'google_oauth'
  -- For kind='password'
  password_hash   TEXT,                        -- PBKDF2-HMAC-SHA256, stored as `pbkdf2$<iter>$<salt_b64>$<hash_b64>`
  -- For kind='google_oauth'
  oauth_provider  TEXT,                        -- 'google', 'microsoft'
  oauth_subject   TEXT,                        -- provider's stable user id
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX credential_user_idx ON credential (user_id, kind);
CREATE UNIQUE INDEX credential_oauth_idx
  ON credential (oauth_provider, oauth_subject)
  WHERE oauth_provider IS NOT NULL;

-- Active sessions. Cookie is a random token; we store its SHA-256 hash.
CREATE TABLE session (
  id              TEXT PRIMARY KEY,           -- ULID (for admin lookup); separate from the secret
  token_hash      TEXT NOT NULL UNIQUE,        -- SHA-256(hex) of the cookie value
  user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ip              TEXT,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,            -- absolute timeout
  revoked_at      INTEGER
);

CREATE INDEX session_user_idx ON session (user_id, revoked_at);
CREATE INDEX session_expiry_idx ON session (expires_at);

-- Single-use tokens for email verify, magic link, password reset, invitation.
-- Cleartext is delivered once (via email); only the SHA-256 hash lives here.
CREATE TABLE auth_token (
  token_hash      TEXT PRIMARY KEY,            -- SHA-256(hex) of the token
  kind            TEXT NOT NULL,               -- 'verify_email' | 'magic_link' | 'password_reset' | 'invitation'
  user_id         TEXT REFERENCES user(id) ON DELETE CASCADE,  -- nullable for invitation-by-email before signup
  email           TEXT,                        -- used for invitation / email-change flows
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,
  metadata_json   TEXT,                        -- free-form JSON blob (e.g. target email for email change, org_id+role for invitation)
  created_at      INTEGER NOT NULL
);

CREATE INDEX auth_token_user_idx ON auth_token (user_id, kind);
CREATE INDEX auth_token_expiry_idx ON auth_token (expires_at);

-- Append-only log of significant actions. Don't over-index; small table, point reads.
CREATE TABLE audit_event (
  id              TEXT PRIMARY KEY,           -- ULID (sortable by time)
  actor_user_id   TEXT,                        -- null for anonymous / pre-login actions
  subject_type    TEXT NOT NULL,               -- 'user' | 'session' | 'project' | 'org' | ...
  subject_id      TEXT,
  action          TEXT NOT NULL,               -- 'user.signup', 'session.login', 'project.publish', ...
  metadata_json   TEXT,
  ip              TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX audit_subject_idx ON audit_event (subject_type, subject_id, created_at DESC);
CREATE INDEX audit_actor_idx ON audit_event (actor_user_id, created_at DESC);
