import type { Env } from '../env';
import {
  reapDeletedUsers,
  reapDeletedProjects,
  summarizeWeeklyMetrics,
  expireEnterpriseGrants,
  publishDueSchedules,
  runOwnerDigest,
  runTrialEndingReminders,
} from './tasks';
import { uploadPendingConversions } from '../marketing/ads/oci';
import { sendOciAlert } from '../email';

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
      // Alert on any rejection so an OCI failure can never again die silently.
      if (result.failedThisRun > 0 || result.markedPermanentlyFailed > 0) {
        await sendOciAlert(env, {
          attempted: result.attempted,
          uploaded: result.uploaded,
          failedThisRun: result.failedThisRun,
          markedPermanentlyFailed: result.markedPermanentlyFailed,
          sampleErrors: result.errors.map((e) => e.message),
        }).catch((e) => console.error('[cron:oci] alert failed', e));
      }
    } catch (err) {
      console.error('[cron:oci] failed', err);
      // Fatal (e.g. OAuth token exchange failed) — surface it too.
      await sendOciAlert(env, {
        attempted: 0, uploaded: 0, failedThisRun: 0, markedPermanentlyFailed: 0,
        sampleErrors: [], fatal: err instanceof Error ? err.message : String(err),
      }).catch((e) => console.error('[cron:oci] alert failed', e));
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
    // "Your no-card Planner trial ends in 3 days" reminders (in-app trials have
    // no Stripe subscription, so Stripe's trial_will_end never fires for them).
    try {
      const result = await runTrialEndingReminders(env);
      if (result.sent) console.log('[cron:trial-reminders]', JSON.stringify({ sent: result.sent }));
    } catch (err) {
      console.error('[cron:trial-reminders] failed', err);
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
