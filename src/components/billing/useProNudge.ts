import { useCallback } from 'react';
import { useStore } from '../../store';
import { useEditorPlan } from './useEditorPlan';
import { fireProNudge, type ProIntentAction } from '../../services/proIntent';

/**
 * Hook for toast-style upgrade nudges fired from inside the editor (currently
 * the publish/hosting-intent nudge after a free user exports a feed).
 *
 * Returns a `fire(action, source)` that runs the shared once-per-trigger +
 * eligibility gate (logged-in free user only) and, when it fires for the first
 * time, both records the pro-intent signal AND reveals the toast. Returns
 * whether the nudge fired so callers can branch if they need to. Plan is read
 * via useEditorPlan so an org-owned feed uses the org's plan (a free user
 * editing an Agency org's feed is correctly NOT nudged).
 */
export function useProNudge(): (action: ProIntentAction, source?: string) => boolean {
  const currentUser = useStore((s) => s.currentUser);
  const plan = useEditorPlan();
  const setProNudgeToast = useStore((s) => s.setProNudgeToast);

  return useCallback(
    (action: ProIntentAction, source?: string) => {
      const fired = fireProNudge({ loggedIn: !!currentUser, plan, action, source });
      if (fired) setProNudgeToast({ action });
      return fired;
    },
    [currentUser, plan, setProNudgeToast],
  );
}
