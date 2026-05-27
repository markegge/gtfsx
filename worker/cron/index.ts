import type { Env } from '../env';
import { reapDeletedUsers, summarizeWeeklyMetrics, expireEnterpriseGrants } from './tasks';
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

  // Default (03:00 UTC) bucket: account/billing housekeeping.
  try {
    await reapDeletedUsers(env);
  } catch (err) {
    console.error('[cron] reapDeletedUsers failed', err);
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
