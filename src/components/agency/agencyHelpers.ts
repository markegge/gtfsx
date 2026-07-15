import { generateId } from '../../services/idGenerator';
import type { Agency, FareAttribute, Route } from '../../types/gtfs';

/**
 * Seed a new agency row for the Agency panel (both the empty state and the
 * "+ Add Agency" button use this, so a feed's first and second agency are
 * created identically).
 *
 * The GTFS-required fields are all present: `agency_id` is generated (the spec
 * requires one on every agency once a feed has more than one, and the panel
 * shows it so the user can rename it to something meaningful), name and URL are
 * left blank for the user to fill, and the timezone defaults to the timezone the
 * feed's existing agencies already use — a joint feed's operators are nearly
 * always in the same timezone, and a wrong timezone shifts every departure.
 */
export function newAgencyDraft(existing: Agency[]): Agency {
  return {
    agency_id: generateId('agency'),
    agency_name: '',
    agency_url: '',
    agency_timezone: existing[0]?.agency_timezone || 'America/Denver',
  };
}

/**
 * How many rows still point at this agency. Deleting an agency does not cascade
 * (see `removeAgencyAt`), so the panel uses this to block a delete that would
 * orphan routes or fares, and to say how many rows are in the way.
 *
 * A blank `agency_id` matches blank references: on a feed whose agency has no
 * id, its routes carry no agency_id either, and those rows do belong to it.
 * Counting them keeps the guard conservative rather than clever.
 */
export function agencyReferenceCount(
  agency: Agency,
  routes: Route[],
  fareAttributes: FareAttribute[],
): { routes: number; fares: number; total: number } {
  const id = agency.agency_id ?? '';
  const routeCount = routes.filter((r) => (r.agency_id ?? '') === id).length;
  const fareCount = fareAttributes.filter((f) => (f.agency_id ?? '') === id).length;
  return { routes: routeCount, fares: fareCount, total: routeCount + fareCount };
}
