import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner } from '../ui/Banner';
import { useStore } from '../../store';

const DAY_MS = 24 * 60 * 60 * 1000;

// Dismissal is scoped to the UTC day so a dismissed banner reappears the next
// day (per the spec: dismissible per session, reappears daily).
function dismissKey(): string {
  return `gb_trial_banner_dismissed_${new Date().toISOString().slice(0, 10)}`;
}

/**
 * In-editor status bar shown while the active org workspace is on a no-card
 * Planner trial. Shows days remaining + a subscribe CTA. Dismissible per day,
 * but in the final 3 days it becomes prominent and non-dismissible.
 *
 * Trial detection mirrors the server model: a trial-granted agency plan has
 * trialEndsAt set (a comp grant leaves it null) AND still carries a future
 * planExpiresAt (a paid conversion clears planExpiresAt, so a converted org
 * stops matching here).
 */
export function TrialBanner() {
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const userOrgs = useStore((s) => s.userOrgs);
  // Captured once at mount (days-left only changes across days, so a session's
  // worth of staleness is fine) and kept out of render to satisfy purity lint.
  const [now] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(dismissKey()) === '1';
    } catch {
      return false;
    }
  });

  const trial = useMemo(() => {
    if (activeWorkspace.type !== 'org') return null;
    const org = userOrgs.find((o) => o.id === activeWorkspace.orgId);
    if (!org) return null;
    if (org.plan !== 'agency') return null;
    const ends = org.trialEndsAt ?? null;
    // Not a trial (paid sub / comp grant), or the org converted to paid
    // (planExpiresAt cleared), or already expired.
    if (ends == null || org.planExpiresAt == null) return null;
    if (ends <= now) return null;
    const daysLeft = Math.max(1, Math.ceil((ends - now) / DAY_MS));
    return { orgId: org.id, daysLeft };
  }, [activeWorkspace, userOrgs, now]);

  if (!trial) return null;

  // Final stretch: prominent + non-dismissible.
  const urgent = trial.daysLeft <= 3;
  if (dismissed && !urgent) return null;

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(dismissKey(), '1');
    } catch {
      // ignore storage failures — worst case the banner shows again on reload
    }
    setDismissed(true);
  };

  const dayLabel = trial.daysLeft === 1 ? '1 day' : `${trial.daysLeft} days`;
  const upgradeHref = `/pricing?ownerType=org&ownerId=${encodeURIComponent(trial.orgId)}`;

  return (
    <Banner
      variant={urgent ? 'promo' : 'info'}
      onDismiss={urgent ? undefined : handleDismiss}
      actions={
        <Link to={upgradeHref} className="font-semibold underline hover:no-underline whitespace-nowrap">
          Subscribe to keep Planner
        </Link>
      }
    >
      Planner trial: <strong>{dayLabel} left</strong>. No credit card on file, subscribe any time to keep your
      hosted feeds and the full planning suite.
    </Banner>
  );
}
