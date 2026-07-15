-- 0024: feed license on feed_project.
--
-- license_spdx is the SPDX short identifier for the feed's license
-- (e.g. 'CC0-1.0', 'CC-BY-4.0', 'ODbL-1.0'), NULL when the publisher hasn't
-- declared one. Chosen in the publish dialog, sent on the publish request, and
-- emitted into feed_info.json + the DMFR license block.
--
-- NOTE: there is deliberately NO project-level NTD ID column here. An agency's
-- NTD ID lives on the AGENCY, inside the feed (agency.external_id — an optional
-- custom column on agency.txt), so it already rides along in the snapshotted
-- state JSON. The publication endpoints read it from there, per agency:
-- feed_info.json emits an `agencies[]` projection and the DMFR document emits
-- one operator per agency with `tags.us_ntd_id`. A single project-level ID
-- could not describe a multi-agency feed anyway. NTD IDs are STRINGS with
-- significant leading zeros ("00123") — never store or parse one as a number.

ALTER TABLE feed_project ADD COLUMN license_spdx TEXT;
