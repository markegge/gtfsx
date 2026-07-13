import type { Env } from '../env';
import {
  reapDeletedUsers,
  reapDeletedProjects,
  summarizeWeeklyMetrics,
  expireEnterpriseGrants,
  publishDueSchedules,
  runOwnerDigest,
} from './tasks';
import { uploadPendingConversions } from '../marketing/ads/oci';

// Scheduled worker entry point. Invoked from worker/index.ts#scheduled().
// Cron triggers are registered in wrangler.jsonc → triggers.crons; we
// dispatch by `event.cron` so each trigger runs only its intended work.
//
// Keep tasks independent: a failure in one should not prevent others from
// running. We therefore log-and-continue rather than rethrow.
export async function runScheduled(
  event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // Every 15 min — fire any scheduled publishes whose time has arrived
  // (worker/projects/routes.ts → POST /:id/publish/schedule).
  if (event.cron === '*/15 * * * *') {
    try {
      const result = await publishDueSchedules(env);
      if (result.published || result.failed) console.log('[cron:scheduled-publish]', JSON.stringify(result));
    } catch (err) {
      console.error('[cron:scheduled-publish] failed', err);
    }
    return;
  }

  // 09:00 UTC — Google Ads Offline Conversion Import only. See
  // worker/marketing/ads/oci.ts and docs/GOOGLE_ADS_PLAN.md §3.2.
  if (event.cron === '0 9 * * *') {
    try {
      const result = await uploadPendingConversions(env);
      console.log('[cron:oci]', JSON.stringify(result));
    } catch (err) {
      console.error('[cron:oci] failed', err);
    }
    return;
  }

  // 13:00 UTC daily (~07:00 MT in MDT / 06:00 in MST) — owner daily digest.
  // Replaces the per-signup owner BCC with one summary email. Gated by
  // OWNER_DIGEST_ENABLED + OWNER_DIGEST_EMAIL (see runOwnerDigest).
  if (event.cron === '0 13 * * *') {
    try {
      const result = await runOwnerDigest(env);
      console.log('[cron:owner-digest]', JSON.stringify({ sent: result.sent, reason: result.reason }));
    } catch (err) {
      console.error('[cron:owner-digest] failed', err);
    }
    return;
  }

  // Default (03:00 UTC) bucket: account/billing housekeeping.
  try {
    await reapDeletedUsers(env);
  } catch (err) {
    console.error('[cron] reapDeletedUsers failed', err);
  }

  // Trash: feeds deleted individually (not via an account deletion) whose
  // 30-day restore window has run out. Runs AFTER the user reaper so feeds
  // already purged with their owner are simply not candidates here.
  try {
    await reapDeletedProjects(env);
  } catch (err) {
    console.error('[cron] reapDeletedProjects failed', err);
  }

  try {
    await summarizeWeeklyMetrics(env);
  } catch (err) {
    console.error('[cron] summarizeWeeklyMetrics failed', err);
  }

  try {
    await expireEnterpriseGrants(env);
  } catch (err) {
    console.error('[cron] expireEnterpriseGrants failed', err);
  }
}
