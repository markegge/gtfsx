import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { PRO_NUDGE_COPY } from '../../services/proIntent';

/**
 * Non-modal upgrade toast for the contextual upgrade nudges (publish/hosting,
 * feed-cap, mini-site). Mounted once in the editor shell; renders only when
 * uiSlice.proNudgeToast is set (a logged-in free user just hit a paid-feature moment).
 * It stays put until the user dismisses it (the × or the CTA) — no auto-
 * dismiss, so it can't vanish before it's read. Links to /pricing.
 */
export function ProUpgradeToast() {
  const toast = useStore((s) => s.proNudgeToast);
  const setProNudgeToast = useStore((s) => s.setProNudgeToast);
  const navigate = useNavigate();

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
