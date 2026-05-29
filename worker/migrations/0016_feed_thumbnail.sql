-- Route-map thumbnails for feeds. A per-project thumbnail (whole-system map,
-- routes drawn in their route_color) is rendered via the Mapbox Static Images
-- API and cached in R2 at projects/<id>/thumbnail-1200x630.png and
-- projects/<id>/thumbnail-400x300.png. It's used as the og:image on the public
-- feed landing page and as the image on feed cards in the feeds list.
--
-- thumbnail_geom_hash : hash of the route geometry + colors the current
--   thumbnail was rendered from. Generation is gated on this so routine
--   autosaves (which don't touch route geometry) don't re-hit the Mapbox API.
-- thumbnail_version   : 0 = never generated. Increments on each regeneration;
--   doubles as the ?v= cache-buster on the public thumbnail URL.

ALTER TABLE feed_project ADD COLUMN thumbnail_geom_hash TEXT;
ALTER TABLE feed_project ADD COLUMN thumbnail_version INTEGER NOT NULL DEFAULT 0;

-- Reversible: ALTER TABLE feed_project DROP COLUMN thumbnail_version;
--             ALTER TABLE feed_project DROP COLUMN thumbnail_geom_hash;
