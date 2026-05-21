import type { Env } from '../env';
import { reapDeletedUsers, summarizeWeeklyMetrics, expireEnterpriseGrants } from './tasks';

// Scheduled worker entry point. Invoked from worker/index.ts#scheduled().
// Cron trigger is registered in wrangler.jsonc -> triggers.crons (daily 03:00 UTC).
//
// Keep tasks independent: a failure in one should not prevent others from
// running. We therefore log-and-continue rather than rethrow.
export async function runScheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
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
