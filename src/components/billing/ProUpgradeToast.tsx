import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { PRO_NUDGE_COPY } from '../../services/proIntent';

// How long the toast lingers before auto-dismissing (it has already recorded
// the intent + marked itself shown, so dismissing never re-triggers it). Long
// enough to read + click, short enough to stay non-naggy.
const AUTO_DISMISS_MS = 14000;

/**
 * Non-modal upgrade toast for the publish/hosting-intent nudge (nudge "a").
 * Mounted once in the editor shell; renders only when uiSlice.proNudgeToast is
 * set (a logged-in free user just exported a feed). Dismissible and self-
 * dismissing. Links to /pricing for the gated feature.
 */
export function ProUpgradeToast() {
  const toast = useStore((s) => s.proNudgeToast);
  const setProNudgeToast = useStore((s) => s.setProNudgeToast);
  const navigate = useNavigate();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setProNudgeToast(null), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast, setProNudgeToast]);

  if (!toast) return null;
  const copy = PRO_NUDGE_COPY[toast.action];

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-sand bg-white shadow-lg p-4 flex items-start gap-3"
    >
      <div className="flex-1">
        <p className="text-sm text-dark-brown">{copy.message}</p>
        <button
          onClick={() => {
            setProNudgeToast(null);
            navigate(`/pricing?feature=${encodeURIComponent(copy.feature)}`);
          }}
          className="mt-2 inline-block rounded-md bg-coral px-3 py-1.5 font-heading text-xs font-bold text-white hover:bg-[#d4603a] transition-colors"
        >
          {copy.cta}
        </button>
      </div>
      <button
        onClick={() => setProNudgeToast(null)}
        aria-label="Dismiss"
        className="shrink-0 -mt-1 -mr-1 w-7 h-7 flex items-center justify-center rounded-md text-warm-gray hover:text-dark-brown hover:bg-cream text-lg leading-none transition-colors"
      >
        ×
      </button>
    </div>
  );
}
