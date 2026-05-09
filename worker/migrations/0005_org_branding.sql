-- Per-organization brand logo. Uploaded by org admins/owners through
-- /api/orgs/:id/logo (multipart), stored in R2 at the FEEDS bucket key
-- recorded here. Served publicly at feeds.*/_/orgs/<id>/logo. Embed
-- pages render this next to the agency name on org-owned feeds.
ALTER TABLE organization ADD COLUMN brand_logo_r2_key TEXT;
ALTER TABLE organization ADD COLUMN brand_logo_content_type TEXT;
ALTER TABLE organization ADD COLUMN brand_logo_updated_at INTEGER;
