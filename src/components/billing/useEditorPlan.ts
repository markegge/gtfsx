import { useMemo } from 'react';
import { useStore } from '../../store';
import type { Plan } from '../../services/billingApi';

/**
 * Returns the effective plan that should be used for paywall decisions in
 * the editor:
 *  - org-owned active project → org's plan
 *  - user-owned active project → user's plan
 *  - anonymous (no active server project) → 'free'
 *
 * The server still enforces the real gate based on project ownership; the
 * UI overlay is a fast hint that mirrors that policy.
 */
export function useEditorPlan(): Plan {
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const userOrgs = useStore((s) => s.userOrgs);
  const currentUser = useStore((s) => s.currentUser);

  return useMemo(() => {
    if (!currentUser) return 'free';
    if (activeServerProjectId) {
      const project = feedsProjects.find((p) => p.id === activeServerProjectId);
      if (project?.ownerType === 'org') {
        const org = userOrgs.find((o) => o.id === project.ownerId);
        if (org?.plan) return org.plan;
        return 'free';
      }
    }
    return (currentUser.plan ?? 'free') as Plan;
  }, [activeServerProjectId, feedsProjects, userOrgs, currentUser]);
}
