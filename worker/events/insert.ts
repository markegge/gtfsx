// Shared `event` INSERT. One place owns the column list so the two write
// paths — the client beacon endpoint (worker/events/routes.ts) and
// server-side conversion events like GET /book-demo
// (worker/marketing/bookDemo.ts) — can't drift.
//
// Same privacy contract as the beacon: no IP, no User-Agent, no user id
// stored. See worker/migrations/0007_events.sql.

import { ulid } from 'ulidx';

export interface EventInsert {
  kind: string;
  path: string;
  ref?: string | null;
  // `event.session_id` is NOT NULL — callers without a client beacon session
  // (server-side events) mint a random one per event.
  sessionId: string;
  country?: string | null;
  label?: string | null;
  gclid?: string | null;
}

export async function insertEvent(db: D1Database, e: EventInsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event (id, ts, kind, path, ref, session_id, country, label, gclid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ulid(),
      Date.now(),
      e.kind,
      e.path,
      e.ref ?? null,
      e.sessionId,
      e.country ?? null,
      e.label ?? null,
      e.gclid ?? null,
    )
    .run();
}
