-- 0031: optional two-factor authentication (email codes now, SMS via Twilio
-- Verify later). Disabled by default; a user opts in per-account, and an org
-- admin can require it for every member.
--
-- Additive only. Existing rows get the defaults (twofa off, no phone).
--
-- NOTE on column affinity: the timestamp columns are INTEGER (unix ms), matching
-- every other table in this schema (auth_token/session store Date.now() as
-- INTEGER). This deliberately differs from the spec's placeholder TEXT so range
-- comparisons (`expires_at < ?`) stay numeric rather than tripping SQLite's
-- "INTEGER is always less than TEXT" rule.

ALTER TABLE user ADD COLUMN twofa_method TEXT NOT NULL DEFAULT 'none'; -- none|email|sms
ALTER TABLE user ADD COLUMN twofa_enrolled_at INTEGER;                 -- unix ms; set when 2FA is enabled
ALTER TABLE user ADD COLUMN phone TEXT;                                -- E.164, SMS phase
ALTER TABLE user ADD COLUMN phone_verified_at INTEGER;                 -- unix ms, SMS phase
ALTER TABLE user ADD COLUMN sms_consent_at INTEGER;                    -- unix ms, Twilio consent evidence, SMS phase
ALTER TABLE user ADD COLUMN sms_consent_ip TEXT;                       -- Twilio consent evidence, SMS phase
ALTER TABLE organization ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0;

-- A single 2FA code challenge. Dedicated table (not auth_token) because codes
-- need an attempts cap, which auth_token has no column for.
CREATE TABLE twofa_challenge (
  id TEXT PRIMARY KEY,               -- ULID (same generator as user/session ids)
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the opaque client-held token (256-bit random, like sessions)
  code_hash TEXT NOT NULL,           -- SHA-256 of `${challengeId}:${code}` (id acts as salt)
  purpose TEXT NOT NULL,             -- login|enroll|disable
  method TEXT NOT NULL,              -- email|sms
  metadata_json TEXT,               -- e.g. {"enrollMethod":"email"}
  attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- created + 10 min
  last_sent_at INTEGER NOT NULL,     -- resend cooldown anchor
  consumed_at INTEGER
);
CREATE INDEX idx_twofa_challenge_user ON twofa_challenge(user_id);
