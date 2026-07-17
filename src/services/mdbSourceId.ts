// Mobility Database import provenance (issue #47).
//
// When a feed is imported FROM the Mobility Database, we capture the numeric
// source id so the open catalog (docs/catalog-spec.md) can emit it as the
// "switcher" `mdb_source_id` — telling MobilityData to UPDATE the existing
// source rather than create a duplicate. The store field is `mdbSourceId`
// (projectSlice), projected to feed_project.mdb_source_id at publish.
//
// Mobility Database feed ids are strings shaped `mdb-<n>`, where <n> is the
// numeric source id (their `mdb_source_id`). Deep-link callers sometimes pass
// the bare number instead, so accept both forms; reject anything else so we
// never guess a source id from an unrelated identifier (e.g. a transit.land
// onestop_id).

/**
 * Parse a Mobility Database feed identifier into its numeric source id.
 * Accepts `mdb-1749` or `1749`; returns the positive integer, or null for
 * anything that isn't a clean MDB source id (so callers can safely skip
 * stamping provenance rather than guessing).
 */
export function parseMdbSourceId(id: string | null | undefined): number | null {
  if (typeof id !== 'string') return null;
  const m = /^\s*(?:mdb-)?(\d+)\s*$/i.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
