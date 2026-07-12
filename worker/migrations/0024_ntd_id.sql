-- 0024: NTD ID + feed license on feed_project.
--
-- FTA floated requiring agency_id == NTD ID, withdrew it (July 2025), and now
-- crosswalks published feeds → NTD IDs itself via the enhanced P-50 form. We
-- carry the agency's NTD ID through publication so the crosswalk survives into
-- Transitland / the Mobility Database (see the DMFR document we emit at
-- feeds.gtfsx.com/<slug>/dmfr.json, which puts it on operator.tags.us_ntd_id).
--
-- ntd_id is a *projection*: the editor's feed state is the source of truth
-- (projectSlice.ntdId, persisted to IndexedDB + the R2 state snapshot); this
-- column is written at publish time so the public feeds origin can serve it
-- without inflating the state blob.
--
-- NTD IDs are 5-digit STRINGS with significant leading zeros ("00123"). TEXT,
-- never INTEGER — an INTEGER column would silently destroy the leading zeros.
--
-- license_spdx is the SPDX short identifier for the feed's license
-- (e.g. 'CC0-1.0', 'CC-BY-4.0', 'ODbL-1.0'), NULL when the publisher hasn't
-- declared one. Emitted into feed_info.json + the DMFR license block.

ALTER TABLE feed_project ADD COLUMN ntd_id TEXT;
ALTER TABLE feed_project ADD COLUMN license_spdx TEXT;
