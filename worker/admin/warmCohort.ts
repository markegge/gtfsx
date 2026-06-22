// Warm-cohort export — the founder-outreach list.
//
// One CSV row per (non-deleted) user account, scored by demonstrated
// willingness to pay so the top ~15 rows ARE the outreach list. Admin/staff
// gated (mounted on adminRouter, which applies requireAuth + requireStaff).
// Internal-only: no emailing, no external calls, never exposed to the app.
//
// Signal provenance — read before trusting a column:
//   - Per-account signals come from authenticated D1 (`user`, `feed_project`,
//     `publication`, `organization_membership`, `pro_intent`).
//   - The cookieless `event` table (0007) is DELIBERATELY ANONYMOUS (no
//     user_id), so it CANNOT contribute any per-account signal. Several
//     columns are therefore best-effort proxies derived from D1 timestamps;
//     each is called out inline below.

import type { Env } from '../env';

// ─── Freemail / org inference ───────────────────────────────────────────────

// Brand tokens for consumer mailbox providers (the handoff's list:
// gmail/outlook/yahoo/hotmail/icloud/aol/proton/live/msn) plus a few close
// variants. We match on the domain's first label (SLD), which is where these
// providers always put their brand (gmail.com, proton.me, yahoo.co.uk, …).
const FREEMAIL_BRANDS = new Set([
  'gmail', 'googlemail',
  'outlook', 'hotmail', 'live', 'msn',
  'yahoo', 'ymail', 'rocketmail',
  'icloud',
  'aol',
  'proton', 'protonmail',
]);

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export function isFreemail(domain: string): boolean {
  if (!domain) return false;
  const sld = domain.split('.')[0];
  return FREEMAIL_BRANDS.has(sld);
}

/**
 * org_name derivation:
 *   - freemail domain            → 'individual'
 *   - else org membership name   → matched organization name
 *   - else                       → the bare email domain (e.g. 'cityofx.gov')
 */
export function deriveOrgName(domain: string, membershipOrgName: string | undefined): string {
  if (isFreemail(domain)) return 'individual';
  if (membershipOrgName) return membershipOrgName;
  return domain || 'individual';
}

// ─── Scoring ────────────────────────────────────────────────────────────────

// Weighted rank. The handoff ordering is, strongest → weakest:
//   attempted_pro_action ≫ exported ≫ at_free_cap ≫ has_flex_zones ≫ repeat-active.
// Big gaps between weights make the tiers strict for realistic (small) counts —
// a single attempted-Pro-action outranks any pile of weaker signals — while
// still letting counts within a tier break ties. `is_consultant_signal` is a
// small secondary bonus (consultants = high willingness to pay) that never
// reorders the primary tiers.
const W_ATTEMPTED = 100_000; // per pro_intent row — THE hottest signal
const W_EXPORTED = 1_000;    // per exported/published artifact (proxy)
const W_AT_CAP = 100;        // hit the free 3-feed wall
const W_FLEX = 40;           // authored Flex zones (our differentiated wedge)
const W_ACTIVE_DAY = 1;      // per distinct active day (repeat use = stickiness)
const W_CONSULTANT = 10;     // multi-agency consultant signal (secondary)

export interface WarmRow {
  email: string;
  account_created_at: number | null;
  last_active_at: number | null;
  org_name: string;
  saved_feeds_count: number;
  at_free_cap: boolean;
  exported_gtfs_count: number;
  has_flex_zones: boolean;
  distinct_active_days_30d: number;
  sessions_last_30d: number;
  attempted_pro_action_count: number;
  attempted_pro_action_last_action: string | null;
  attempted_pro_action_last_ts: number | null;
  is_consultant_signal: boolean;
  score: number;
}

export function scoreRow(r: WarmRow): number {
  return (
    r.attempted_pro_action_count * W_ATTEMPTED +
    r.exported_gtfs_count * W_EXPORTED +
    (r.at_free_cap ? W_AT_CAP : 0) +
    (r.has_flex_zones ? W_FLEX : 0) +
    r.distinct_active_days_30d * W_ACTIVE_DAY +
    (r.is_consultant_signal ? W_CONSULTANT : 0)
  );
}

// ─── CSV rendering ──────────────────────────────────────────────────────────

const COLUMNS = [
  'email',
  'account_created_at',
  'last_active_at',
  'org_name',
  'saved_feeds_count',
  'at_free_cap',
  'exported_gtfs_count',
  'has_flex_zones',
  'distinct_active_days_30d',
  'sessions_last_30d',
  'attempted_pro_action',
  'is_consultant_signal',
  'score',
] as const;

function csvEscape(s: string): string {
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function isoOrEmpty(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

// Compose the single `attempted_pro_action` cell from count + most-recent.
function attemptedCell(r: WarmRow): string {
  if (r.attempted_pro_action_count <= 0) return '0';
  if (r.attempted_pro_action_last_action) {
    return `${r.attempted_pro_action_count} (last ${r.attempted_pro_action_last_action} @ ${isoOrEmpty(r.attempted_pro_action_last_ts)})`;
  }
  return String(r.attempted_pro_action_count);
}

export function renderCsv(rows: WarmRow[]): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.email),
      csvEscape(isoOrEmpty(r.account_created_at)),
      csvEscape(isoOrEmpty(r.last_active_at)),
      csvEscape(r.org_name),
      String(r.saved_feeds_count),
      r.at_free_cap ? 'true' : 'false',
      String(r.exported_gtfs_count),
      r.has_flex_zones ? 'true' : 'false',
      String(r.distinct_active_days_30d),
      String(r.sessions_last_30d),
      csvEscape(attemptedCell(r)),
      r.is_consultant_signal ? 'true' : 'false',
      String(r.score),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

// ─── Data gathering + assembly ──────────────────────────────────────────────

interface UserRow {
  id: string;
  email: string;
  plan: string | null;
  created_at: number;
  updated_at: number;
}
interface FeedAggRow {
  user_id: string;
  active_feeds: number;
  distinct_names: number;
  max_ws: number;
  max_updated: number;
}
interface ActivityRow {
  user_id: string;
  active_days_30d: number;
  sessions_30d: number;
}
interface PublishedRow {
  user_id: string;
  published_n: number;
}
interface IntentAggRow {
  user_id: string;
  intent_n: number;
  export_intent_n: number;
}
interface IntentRecentRow {
  user_id: string;
  action: string;
  ts: number;
}
interface MembershipRow {
  user_id: string;
  org_name: string;
  role: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build the warm-cohort CSV. Set-based (a fixed handful of grouped queries, not
 * N+1) and assembled in JS. Returns the CSV text already sorted by score desc.
 */
export async function buildWarmCohortCsv(
  env: Env,
  now: number = Date.now(),
): Promise<{ csv: string; rowCount: number }> {
  const cutoff = now - THIRTY_DAYS_MS;
  const db = env.DB;

  // Run the independent aggregates concurrently.
  const [
    usersRes,
    feedAggRes,
    activityRes,
    publishedRes,
    intentAggRes,
    intentRecentRes,
    membershipRes,
  ] = await Promise.all([
    db.prepare(
      `SELECT id, email, plan, created_at, updated_at
         FROM user
        WHERE deleted_at IS NULL`,
    ).all<UserRow>(),

    db.prepare(
      `SELECT owner_id AS user_id,
              COUNT(*) AS active_feeds,
              COUNT(DISTINCT name) AS distinct_names,
              MAX(COALESCE(working_state_updated_at, 0)) AS max_ws,
              MAX(COALESCE(updated_at, 0)) AS max_updated
         FROM feed_project
        WHERE owner_type = 'user' AND deleted_at IS NULL AND archived_at IS NULL
        GROUP BY owner_id`,
    ).all<FeedAggRow>(),

    // Best-effort repeat-use signals. The anonymous `event` table has no
    // user_id, so we can't see true per-account sessions. We proxy from
    // feed_project timestamps: distinct calendar days touched in the last 30d,
    // and a coarse "sessions" count = feeds touched in the last 30d. We only
    // hold each feed's LATEST activity timestamp (no per-edit history), so both
    // are lower-bound approximations — documented, partial is OK.
    db.prepare(
      `SELECT owner_id AS user_id,
              COUNT(DISTINCT date(COALESCE(working_state_updated_at, updated_at, created_at) / 1000, 'unixepoch')) AS active_days_30d,
              COUNT(*) AS sessions_30d
         FROM feed_project
        WHERE owner_type = 'user' AND deleted_at IS NULL
          AND COALESCE(working_state_updated_at, updated_at, created_at) >= ?
        GROUP BY owner_id`,
    ).bind(cutoff).all<ActivityRow>(),

    db.prepare(
      `SELECT fp.owner_id AS user_id, COUNT(DISTINCT p.project_id) AS published_n
         FROM publication p
         JOIN feed_project fp ON fp.id = p.project_id
        WHERE fp.owner_type = 'user' AND fp.deleted_at IS NULL
        GROUP BY fp.owner_id`,
    ).all<PublishedRow>(),

    db.prepare(
      `SELECT user_id,
              COUNT(*) AS intent_n,
              SUM(CASE WHEN action IN ('publish_intent','checkout_started') THEN 1 ELSE 0 END) AS export_intent_n
         FROM pro_intent
        GROUP BY user_id`,
    ).all<IntentAggRow>(),

    // Most-recent intent action per user (join the per-user MAX(ts) back to the
    // row). Ties on ts are vanishingly unlikely (ms precision); we keep the
    // first seen.
    db.prepare(
      `SELECT p.user_id, p.action, p.ts
         FROM pro_intent p
         JOIN (SELECT user_id, MAX(ts) AS mts FROM pro_intent GROUP BY user_id) m
           ON m.user_id = p.user_id AND m.mts = p.ts`,
    ).all<IntentRecentRow>(),

    db.prepare(
      `SELECT m.user_id, o.name AS org_name, m.role
         FROM organization_membership m
         JOIN organization o ON o.id = m.org_id
        WHERE o.deleted_at IS NULL`,
    ).all<MembershipRow>(),
  ]);

  const feedAgg = new Map<string, FeedAggRow>();
  for (const r of feedAggRes.results ?? []) feedAgg.set(r.user_id, r);

  const activity = new Map<string, ActivityRow>();
  for (const r of activityRes.results ?? []) activity.set(r.user_id, r);

  const published = new Map<string, number>();
  for (const r of publishedRes.results ?? []) published.set(r.user_id, r.published_n);

  const intentAgg = new Map<string, IntentAggRow>();
  for (const r of intentAggRes.results ?? []) intentAgg.set(r.user_id, r);

  const intentRecent = new Map<string, IntentRecentRow>();
  for (const r of intentRecentRes.results ?? []) {
    if (!intentRecent.has(r.user_id)) intentRecent.set(r.user_id, r);
  }

  // Prefer an owner/admin membership when a user belongs to multiple orgs.
  const membership = new Map<string, MembershipRow>();
  const roleRank = (role: string): number =>
    role === 'owner' ? 3 : role === 'admin' ? 2 : role === 'editor' ? 1 : 0;
  for (const r of membershipRes.results ?? []) {
    const existing = membership.get(r.user_id);
    if (!existing || roleRank(r.role) > roleRank(existing.role)) membership.set(r.user_id, r);
  }

  const rows: WarmRow[] = (usersRes.results ?? []).map((u) => {
    const domain = emailDomain(u.email);
    const freemail = isFreemail(domain);
    const fa = feedAgg.get(u.id);
    const act = activity.get(u.id);
    const intent = intentAgg.get(u.id);
    const recent = intentRecent.get(u.id);

    const savedFeeds = fa?.active_feeds ?? 0;
    const plan = u.plan ?? 'free';
    const atFreeCap = plan === 'free' && savedFeeds >= 3;

    // last_active_at: MAX over the user's feeds of working_state_updated_at /
    // updated_at; fall back to user.updated_at when they own no feeds.
    const feedLastActive = Math.max(fa?.max_ws ?? 0, fa?.max_updated ?? 0);
    const lastActive = feedLastActive > 0 ? feedLastActive : u.updated_at;

    // exported_gtfs_count — BEST-EFFORT. True GTFS exports happen client-side
    // and are recorded only in the anonymous `event` table (no user link), so
    // we proxy with high-intent artifacts we CAN attribute: publish/checkout
    // intents + actually-published feeds.
    const exported = (intent?.export_intent_n ?? 0) + (published.get(u.id) ?? 0);

    // has_flex_zones — BEST-EFFORT false. Flex/demand-response zones live only
    // inside the R2 working-state blob (the editor's `flexZones`); no D1
    // metadata (incl. snapshot summary_json) captures them. An accurate signal
    // would require fetching + gunzipping every user's working-state blob,
    // which we avoid here to keep this export cheap and within Worker
    // subrequest limits. Column + score weight are wired so it can be turned on
    // later (e.g. a nightly job that stamps a flex flag into D1).
    const hasFlexZones = false;

    // is_consultant_signal — non-freemail domain AND the account owns multiple
    // feeds with distinct names (proxy for managing several agencies).
    const isConsultant = !freemail && (fa?.distinct_names ?? 0) >= 2;

    const row: WarmRow = {
      email: u.email,
      account_created_at: u.created_at,
      last_active_at: lastActive,
      org_name: deriveOrgName(domain, membership.get(u.id)?.org_name),
      saved_feeds_count: savedFeeds,
      at_free_cap: atFreeCap,
      exported_gtfs_count: exported,
      has_flex_zones: hasFlexZones,
      distinct_active_days_30d: act?.active_days_30d ?? 0,
      sessions_last_30d: act?.sessions_30d ?? 0,
      attempted_pro_action_count: intent?.intent_n ?? 0,
      attempted_pro_action_last_action: recent?.action ?? null,
      attempted_pro_action_last_ts: recent?.ts ?? null,
      is_consultant_signal: isConsultant,
      score: 0,
    };
    row.score = scoreRow(row);
    return row;
  });

  // Top of the list = hottest. Deterministic tiebreak: more-recent activity,
  // then email.
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      (b.last_active_at ?? 0) - (a.last_active_at ?? 0) ||
      a.email.localeCompare(b.email),
  );

  return { csv: renderCsv(rows), rowCount: rows.length };
}
