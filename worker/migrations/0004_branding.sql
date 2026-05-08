-- Per-project brand color used by the embed renderer (route map / system
-- map / per-stop page / mini-site landing). Optional; falls back to the
-- default coral accent when NULL. Stored as a 6-char hex string with no
-- leading "#".
ALTER TABLE feed_project ADD COLUMN brand_primary_color TEXT;
