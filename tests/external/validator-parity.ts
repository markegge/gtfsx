/**
 * Validator-parity check for GTFS·X (issue #4).
 *
 * DEV/QA tool — NOT a product feature and NOT part of the fast CI gate.
 * It is NETWORK-DEPENDENT (calls the hosted MobilityData validator) and meant to
 * run PERIODICALLY (e.g. weekly cron, or before a release that touches validation
 * or the GTFS spec coverage).
 *
 * What it does: for each of OUR test feeds it runs BOTH validators —
 *   (1) our in-app validator (src/services/validation.ts, via the same parser the
 *       editor uses), and
 *   (2) the canonical MobilityData GTFS validator (hosted, v8.x) —
 * normalizes + maps the two notice vocabularies (see validator-parity-mapping.ts),
 * and prints a per-feed PARITY DIFF:
 *   (a) BOTH catch,
 *   (b) MobilityData catches but WE MISS  ← the key output (our gaps),
 *   (c) only WE flag.
 *
 * Exit code: non-zero ONLY when it finds a NEW gap — a MobilityData ERROR/WARNING
 * code we miss that isn't already accepted in validator-parity-baseline.json for
 * that feed. This keeps it from going red every time MobilityData ships a new
 * rule; intentional gaps are recorded in the baseline.
 *
 * MobilityData flow (verified v8.0.1, 2026-06-04):
 *   POST {API}/create-job {countryCode}        → { jobId, url }   (15-min signed GCS PUT)
 *   PUT  {url} (Content-Type: application/octet-stream)  ← the GTFS .zip
 *   poll {RESULTS}/{jobId}/execution_result.json until { status: "success" }
 *   GET  {RESULTS}/{jobId}/report.json          → { summary, notices[] }
 *
 * Usage:
 *   npm run test:validator-parity                 # run + print diff, exit non-zero on new gaps
 *   npm run test:validator-parity -- --write-baseline   # rewrite baseline to current gaps (review the diff!)
 *
 * Adding feeds: append to FEEDS below (point at a fixture dir or build a zip
 * inline). Adding notice coverage: edit validator-parity-mapping.ts.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { importGtfsZip, loadImportIntoStore } from '../../src/services/gtfsImport';
import { runValidation } from '../../src/services/validation';
import { useStore } from '../../src/store';
import {
  classifyOurNotice,
  MOBILITY_TO_OURS,
  TODO_MOBILITY_CODES,
  type OurNoticeId,
} from './validator-parity-mapping';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BASELINE_PATH = path.join(HERE, 'validator-parity-baseline.json');

const WRITE_BASELINE = process.argv.includes('--write-baseline');

// MobilityData hosted validator endpoints (web/pipeline prd.env in their repo).
const VALIDATOR_API_ROOT = 'https://gtfs-validator-web-mbzoxaljzq-ue.a.run.app';
const VALIDATOR_RESULTS_ROOT = 'https://gtfs-validator-results.mobilitydata.org';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes
const UPSTREAM_TIMEOUT_MS = 30_000;

// ─── Test feed definitions ─────────────────────────────────────────────────
// Each feed produces a GTFS .zip buffer. `id` keys into the baseline JSON.
// Grow this list as we add spec features — give every new capability a feed (or
// a broken variant) so both validators exercise it.
interface FeedDef {
  id: string;
  label: string;
  countryCode: string; // ISO 3166-1 alpha-2; '' = unknown
  build: () => Promise<Buffer>;
}

const STREAMLINE_DIR = path.join(REPO_ROOT, 'streamline_gtfs_march_2026');

/** Zip the bundled streamline (Bozeman) feed exactly as it sits on disk. */
async function buildStreamlineZip(): Promise<Buffer> {
  const zip = new JSZip();
  for (const name of readdirSync(STREAMLINE_DIR)) {
    const full = path.join(STREAMLINE_DIR, name);
    if (!statSync(full).isFile() || !name.endsWith('.txt')) continue;
    zip.file(name, readFileSync(full));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * The streamline feed with DELIBERATE errors injected so BOTH validators have
 * something to catch — proving the harness actually surfaces parity, not just an
 * all-clean feed:
 *   - DROP calendar.txt + calendar_dates.txt → every trip's service_id dangles
 *     (foreign_key_violation in MobilityData; trip_unknown_service for us) and
 *     the feed has no service at all (missing_calendar_and_calendar_date).
 *   - INJECT a stop_times row pointing at a non-existent stop_id
 *     (foreign_key_violation / stop_time_unknown_stop).
 */
async function buildStreamlineBrokenZip(): Promise<Buffer> {
  const zip = new JSZip();
  for (const name of readdirSync(STREAMLINE_DIR)) {
    const full = path.join(STREAMLINE_DIR, name);
    if (!statSync(full).isFile() || !name.endsWith('.txt')) continue;
    // Drop the calendar files entirely.
    if (name === 'calendar.txt' || name === 'calendar_dates.txt') continue;
    if (name === 'stop_times.txt') {
      // Append a dangling-stop row to the first trip in the file.
      const text = readFileSync(full, 'utf8');
      const lines = text.split(/\r?\n/);
      const header = lines[0].split(',');
      const firstDataRow = lines.find((l, i) => i > 0 && l.trim().length > 0);
      const tripId = firstDataRow ? firstDataRow.split(',')[header.indexOf('trip_id')] : 'BROKEN_TRIP';
      // Build a row matching the header width with a bogus stop_id.
      const cells = header.map((col) => {
        if (col === 'trip_id') return tripId;
        if (col === 'stop_id') return 'STOP_DOES_NOT_EXIST';
        if (col === 'stop_sequence') return '999';
        if (col === 'arrival_time' || col === 'departure_time') return '25:00:00';
        return '';
      });
      zip.file(name, text.replace(/\s*$/, '') + '\n' + cells.join(',') + '\n');
      continue;
    }
    zip.file(name, readFileSync(full));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const FEEDS: FeedDef[] = [
  {
    id: 'streamline',
    label: 'Streamline (Bozeman) — pristine bundled feed',
    countryCode: 'US',
    build: buildStreamlineZip,
  },
  {
    id: 'streamline-broken',
    label: 'Streamline + injected errors (dropped calendar, dangling stop_id)',
    countryCode: 'US',
    build: buildStreamlineBrokenZip,
  },
];

// ─── MobilityData validator client ─────────────────────────────────────────
interface CanonicalNotice {
  code: string;
  severity: string; // ERROR | WARNING | INFO
  totalNotices: number;
}
interface CanonicalReport {
  validatorVersion: string | null;
  notices: CanonicalNotice[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function validateWithMobilityData(zip: Buffer, countryCode: string): Promise<CanonicalReport> {
  // 1. create-job → { jobId, url }
  const createRes = await timedFetch(`${VALIDATOR_API_ROOT}/create-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countryCode }),
  });
  if (!createRes.ok) {
    throw new Error(`create-job HTTP ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  }
  const job = (await createRes.json()) as { jobId?: string; url?: string };
  if (!job.jobId || !job.url) throw new Error('create-job response missing jobId/url');

  // 2. PUT the zip to the signed GCS URL.
  // Node's fetch accepts a Uint8Array body; the signed URL expects the raw bytes.
  const putRes = await timedFetch(job.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(zip),
  });
  if (!putRes.ok) {
    throw new Error(`upload PUT HTTP ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
  }

  // 3. Poll execution_result.json until status === success.
  const base = `${VALIDATOR_RESULTS_ROOT}/${job.jobId}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let succeeded = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let execRes: Response;
    try {
      execRes = await timedFetch(`${base}/execution_result.json`, { method: 'GET' });
    } catch {
      continue; // transient — keep polling
    }
    if (execRes.status === 404 || execRes.status === 403) continue; // not ready yet
    if (!execRes.ok) continue;
    const exec = (await execRes.json().catch(() => ({}))) as { status?: string; error?: string };
    const status = (exec.status ?? '').trim().toLowerCase();
    if (status === 'success') {
      succeeded = true;
      break;
    }
    if (status && status !== 'success' && status !== 'pending' && status !== 'running') {
      throw new Error(`validator job ${job.jobId} failed: ${exec.error || status}`);
    }
  }
  if (!succeeded) throw new Error(`validator job ${job.jobId} did not finish within ${POLL_TIMEOUT_MS / 1000}s`);

  // 4. report.json → { summary, notices[] }.
  const reportRes = await timedFetch(`${base}/report.json`, { method: 'GET' });
  if (!reportRes.ok) {
    throw new Error(`report.json HTTP ${reportRes.status}`);
  }
  const report = (await reportRes.json()) as {
    summary?: { validatorVersion?: string };
    notices?: { code?: string; severity?: string; totalNotices?: number }[];
  };
  return {
    validatorVersion: report.summary?.validatorVersion ?? null,
    notices: (report.notices ?? []).map((n) => ({
      code: String(n.code ?? 'unknown'),
      severity: String(n.severity ?? 'INFO').toUpperCase(),
      totalNotices: Number(n.totalNotices ?? 0),
    })),
  };
}

// ─── Our in-app validator ──────────────────────────────────────────────────
async function validateWithOurs(zip: Buffer): Promise<Set<OurNoticeId | '(unclassified)'>> {
  const data = await importGtfsZip(zip as unknown as File);
  loadImportIntoStore(data);
  const messages = runValidation(useStore.getState());
  const ids = new Set<OurNoticeId | '(unclassified)'>();
  for (const m of messages) {
    const id = classifyOurNotice(m.message);
    ids.add(id ?? '(unclassified)');
  }
  return ids;
}

// ─── Parity diff ───────────────────────────────────────────────────────────
interface ParityResult {
  feedId: string;
  validatorVersion: string | null;
  both: string[]; // MobilityData codes both catch
  weMiss: string[]; // MobilityData ERROR/WARNING codes we miss (gaps)
  weMissInfo: string[]; // MobilityData INFO codes we miss (never gating)
  todoGaps: string[]; // codes explicitly deferred in TODO_MOBILITY_CODES (non-gating)
  onlyOurs: (OurNoticeId | '(unclassified)')[]; // ids only we flag
  unmappedMobility: string[]; // codes in NEITHER the mapping table NOR the TODO list — triage these
}

const TODO_SET = new Set(TODO_MOBILITY_CODES);

function diffFeed(
  feedId: string,
  canonical: CanonicalReport,
  ours: Set<OurNoticeId | '(unclassified)'>,
): ParityResult {
  const both: string[] = [];
  const weMiss: string[] = [];
  const weMissInfo: string[] = [];
  const todoGaps: string[] = [];
  const unmappedMobility: string[] = [];
  const coveredOurIds = new Set<OurNoticeId>();

  for (const notice of canonical.notices) {
    const mapped = MOBILITY_TO_OURS[notice.code];
    if (mapped === undefined) {
      // Not in the mapping table. If we've explicitly deferred it, it's a known
      // TODO gap (non-gating); otherwise it's genuinely unmapped — triage it.
      if (TODO_SET.has(notice.code)) todoGaps.push(notice.code);
      else unmappedMobility.push(notice.code);
      continue;
    }
    // Does any of our mapped ids appear in our output for this feed?
    const weCatch = mapped.some((id) => ours.has(id));
    if (mapped.length === 0) {
      // Explicitly-accepted "no equivalent" mapping → always a gap.
      if (notice.severity === 'INFO') weMissInfo.push(notice.code);
      else weMiss.push(notice.code);
      continue;
    }
    if (weCatch) {
      both.push(notice.code);
      for (const id of mapped) if (ours.has(id)) coveredOurIds.add(id);
    } else if (notice.severity === 'INFO') {
      weMissInfo.push(notice.code);
    } else {
      weMiss.push(notice.code);
    }
  }

  // Ids we flagged that no canonical notice accounted for.
  const onlyOurs: (OurNoticeId | '(unclassified)')[] = [];
  for (const id of ours) {
    if (id === '(unclassified)') {
      onlyOurs.push(id);
      continue;
    }
    if (!coveredOurIds.has(id)) onlyOurs.push(id);
  }

  return {
    feedId,
    validatorVersion: canonical.validatorVersion,
    both: dedupe(both),
    weMiss: dedupe(weMiss),
    weMissInfo: dedupe(weMissInfo),
    todoGaps: dedupe(todoGaps),
    onlyOurs: dedupe(onlyOurs),
    unmappedMobility: dedupe(unmappedMobility),
  };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)].sort();
}

// ─── Baseline ──────────────────────────────────────────────────────────────
type Baseline = Record<string, unknown> & { [feedId: string]: string[] | unknown };

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
}

function baselineGapsFor(baseline: Baseline, feedId: string): Set<string> {
  const v = baseline[feedId];
  return new Set(Array.isArray(v) ? (v as string[]) : []);
}

// ─── Reporting ─────────────────────────────────────────────────────────────
function printResult(r: ParityResult, baselineGaps: Set<string>): { newGaps: string[] } {
  const newGaps = r.weMiss.filter((c) => !baselineGaps.has(c));
  console.log(`\n┌─ ${r.feedId}  (MobilityData v${r.validatorVersion ?? '?'})`);
  console.log(`│  ✓ Both catch (${r.both.length}): ${r.both.join(', ') || '—'}`);
  console.log(`│  ⚑ Only we flag (${r.onlyOurs.length}): ${r.onlyOurs.join(', ') || '—'}`);
  console.log(`│  ✗ WE MISS — ERROR/WARNING gaps (${r.weMiss.length}): ${r.weMiss.join(', ') || '—'}`);
  if (r.weMiss.length) {
    const accepted = r.weMiss.filter((c) => baselineGaps.has(c));
    if (accepted.length) console.log(`│      (accepted in baseline: ${accepted.join(', ')})`);
    if (newGaps.length) console.log(`│      ⚠ NEW gaps (fail): ${newGaps.join(', ')}`);
  }
  if (r.weMissInfo.length) console.log(`│  · INFO-only gaps (non-gating, ${r.weMissInfo.length}): ${r.weMissInfo.join(', ')}`);
  if (r.todoGaps.length) console.log(`│  ⋯ Deferred-TODO gaps (non-gating, ${r.todoGaps.length}): ${r.todoGaps.join(', ')}`);
  if (r.unmappedMobility.length) {
    console.log(`│  ? UNMAPPED codes — not in mapping table OR TODO list, triage these (${r.unmappedMobility.length}): ${r.unmappedMobility.join(', ')}`);
  }
  console.log('└─');
  return { newGaps };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== GTFS·X validator-parity check (our validator vs MobilityData) ===');
  console.log('Network-dependent · periodic · NOT part of the fast CI gate.\n');
  console.log(`Mapping table covers ${Object.keys(MOBILITY_TO_OURS).length} MobilityData codes; ` +
    `${TODO_MOBILITY_CODES.length} more listed as TODO.`);

  const baseline = loadBaseline();
  const results: ParityResult[] = [];
  let totalNewGaps = 0;
  const suggestedBaseline: Record<string, string[]> = {};

  for (const feed of FEEDS) {
    console.log(`\n▶ ${feed.label}`);
    const zip = await feed.build();
    console.log(`  feed zipped: ${(zip.length / 1024).toFixed(0)} KB`);

    process.stdout.write('  running our validator ... ');
    const ours = await validateWithOurs(zip);
    console.log(`${ours.size} distinct notice ids`);

    process.stdout.write('  running MobilityData validator (network) ... ');
    const canonical = await validateWithMobilityData(zip, feed.countryCode);
    console.log(`${canonical.notices.length} notices`);

    const r = diffFeed(feed.id, canonical, ours);
    results.push(r);
    suggestedBaseline[feed.id] = r.weMiss;

    const { newGaps } = printResult(r, baselineGapsFor(baseline, feed.id));
    totalNewGaps += newGaps.length;
  }

  if (WRITE_BASELINE) {
    const out: Record<string, unknown> = {
      _comment: (baseline._comment as string) ??
        'Baseline of accepted parity gaps, keyed by feed id. See validator-parity.ts.',
      ...suggestedBaseline,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
    console.log(`\nBaseline rewritten → ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    console.log('Review the diff before committing.');
    process.exit(0);
  }

  console.log(`\n${'='.repeat(64)}`);
  if (totalNewGaps > 0) {
    console.log(`FAIL — ${totalNewGaps} NEW parity gap(s) vs baseline.`);
    console.log('These are MobilityData ERROR/WARNING rules we newly fail to flag.');
    console.log('Either add the check to src/services/validation.ts (+ mapping in');
    console.log('validator-parity-mapping.ts), or accept it via --write-baseline.');
    console.log('='.repeat(64));
    process.exit(1);
  }
  console.log('PASS — no new parity gaps. (Existing accepted gaps remain in the baseline.)');
  console.log('='.repeat(64));
  process.exit(0);
}

main().catch((err) => {
  console.error('\nvalidator-parity ERRORED:', err instanceof Error ? err.message : err);
  // A network/infra error is NOT a parity failure. Exit 2 so a cron can tell
  // "tool broke" from "we have a gap" (exit 1).
  process.exit(2);
});
