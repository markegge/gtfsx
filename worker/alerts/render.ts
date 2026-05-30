// Pure GTFS-Realtime Service Alert rendering: service_alert row → protobuf.
//
// No D1 / R2 / network here — everything is a pure function of the row data so
// it's trivially unit-testable and reusable by both the live feed handler and
// the in-editor preview endpoint. The serving layer is responsible for loading
// rows, filtering by active_period, and resolving the default language.

import { transit_realtime } from 'gtfs-realtime-bindings';

const rt = transit_realtime;

// ─── Enums ──────────────────────────────────────────────────────────────────
//
// Stored as their GTFS-RT string names (e.g. 'CONSTRUCTION'); mapped to the
// protobuf numeric enum at render time. Unknown/empty falls back to the
// spec's UNKNOWN_* member.

export const ALERT_CAUSES = Object.keys(rt.Alert.Cause) as string[];
export const ALERT_EFFECTS = Object.keys(rt.Alert.Effect) as string[];
export const ALERT_SEVERITIES = Object.keys(rt.Alert.SeverityLevel) as string[];

export function isValidCause(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(rt.Alert.Cause, s);
}
export function isValidEffect(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(rt.Alert.Effect, s);
}
export function isValidSeverity(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(rt.Alert.SeverityLevel, s);
}

function causeEnum(s: string): transit_realtime.Alert.Cause {
  return (rt.Alert.Cause as unknown as Record<string, number>)[s] ?? rt.Alert.Cause.UNKNOWN_CAUSE;
}
function effectEnum(s: string): transit_realtime.Alert.Effect {
  return (rt.Alert.Effect as unknown as Record<string, number>)[s] ?? rt.Alert.Effect.UNKNOWN_EFFECT;
}
function severityEnum(s: string): transit_realtime.Alert.SeverityLevel {
  return (rt.Alert.SeverityLevel as unknown as Record<string, number>)[s] ?? rt.Alert.SeverityLevel.UNKNOWN_SEVERITY;
}

// ─── Row shape (already JSON-parsed) ────────────────────────────────────────

export interface ActivePeriod {
  /** POSIX seconds. null/absent = active from the beginning of time. */
  start?: number | null;
  /** POSIX seconds. null/absent = active until further notice. */
  end?: number | null;
}

export interface InformedEntity {
  agency_id?: string;
  route_id?: string;
  route_type?: number;
  direction_id?: number;
  trip_id?: string;
  stop_id?: string;
}

/** The subset of a `service_alert` row that rendering needs. */
export interface AlertRecord {
  id: string;
  cause: string;
  effect: string;
  severity_level: string;
  header_text: string;
  description_text?: string | null;
  url?: string | null;
  active_periods: ActivePeriod[];
  informed_entities: InformedEntity[];
}

// ─── active_period filtering ────────────────────────────────────────────────

/**
 * Is the alert currently active per its active_periods? Per the GTFS-RT spec,
 * an alert with *no* active period is always active; otherwise it is active if
 * `now` falls inside at least one [start, end) window (open-ended either side).
 */
export function isAlertActiveAt(periods: ActivePeriod[], nowSec: number): boolean {
  if (!periods || periods.length === 0) return true;
  return periods.some((p) => {
    const start = p.start ?? null;
    const end = p.end ?? null;
    if (start != null && nowSec < start) return false;
    if (end != null && nowSec >= end) return false;
    return true;
  });
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function translated(text: string, language: string): transit_realtime.ITranslatedString {
  return { translation: [{ text, language }] };
}

/**
 * Map one alert row to a GTFS-RT `Alert`. v1 emits a single-language
 * `TranslatedString` (multi-language is backlog) — still a TranslatedString so
 * adding languages later needs no wire-format change.
 */
export function toAlert(rec: AlertRecord, language = 'en'): transit_realtime.IAlert {
  const informedEntity: transit_realtime.IEntitySelector[] = rec.informed_entities.map((e) => {
    const sel: transit_realtime.IEntitySelector = {};
    if (e.agency_id) sel.agencyId = e.agency_id;
    if (e.route_id) sel.routeId = e.route_id;
    if (e.route_type != null) sel.routeType = e.route_type;
    if (e.direction_id != null) sel.directionId = e.direction_id;
    if (e.stop_id) sel.stopId = e.stop_id;
    if (e.trip_id) sel.trip = { tripId: e.trip_id };
    return sel;
  });

  const alert: transit_realtime.IAlert = {
    activePeriod: rec.active_periods.map((p) => {
      const tr: transit_realtime.ITimeRange = {};
      if (p.start != null) tr.start = p.start;
      if (p.end != null) tr.end = p.end;
      return tr;
    }),
    informedEntity,
    cause: causeEnum(rec.cause),
    effect: effectEnum(rec.effect),
    severityLevel: severityEnum(rec.severity_level),
    headerText: translated(rec.header_text, language),
  };
  if (rec.description_text) alert.descriptionText = translated(rec.description_text, language);
  if (rec.url) alert.url = translated(rec.url, language);
  return alert;
}

export interface BuildOptions {
  /** Feed header timestamp, POSIX seconds. */
  timestamp: number;
  /** Default language for TranslatedStrings (v1 single language). */
  language?: string;
}

/**
 * Build a complete GTFS-RT `FeedMessage` (v2.0, FULL_DATASET) carrying one
 * `FeedEntity` per alert. Callers pass already-filtered, currently-active rows.
 */
export function buildFeedMessage(records: AlertRecord[], opts: BuildOptions): transit_realtime.FeedMessage {
  const language = opts.language ?? 'en';
  return rt.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: '2.0',
      incrementality: rt.FeedHeader.Incrementality.FULL_DATASET,
      timestamp: opts.timestamp,
    },
    entity: records.map((r) => ({ id: r.id, alert: toAlert(r, language) })),
  });
}

/** Serialize a FeedMessage to protobuf wire bytes. */
export function encodeFeedMessage(message: transit_realtime.FeedMessage): Uint8Array {
  return rt.FeedMessage.encode(message).finish();
}

/** Decode protobuf wire bytes back to a FeedMessage (used in tests + round-trips). */
export function decodeFeedMessage(bytes: Uint8Array): transit_realtime.FeedMessage {
  return rt.FeedMessage.decode(bytes);
}

/**
 * The JSON form the `/alerts.json` mirror serves. `enums: String` renders
 * enum *names* (e.g. "CONSTRUCTION") and `longs: Number` renders the uint64
 * timestamp as a plain number — both friendlier for human/JSON consumers.
 */
export function feedMessageToJson(message: transit_realtime.FeedMessage): Record<string, unknown> {
  return rt.FeedMessage.toObject(message, { enums: String, longs: Number, defaults: false });
}
