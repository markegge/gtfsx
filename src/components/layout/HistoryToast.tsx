import { useEffect, useState } from 'react';
import { useHistoryUi } from '../../store/history';

// Transient toast naming the reverted/re-applied action after an undo or redo
// (#49). Visibility is derived from the history UI store's `toast` field (which
// carries a `nonce` so repeated identical actions re-trigger it); the effect
// only schedules the auto-dismiss, flipping `dismissedNonce` once the beat
// elapses — no synchronous setState in the effect body.

const VISIBLE_MS = 1800;

export function HistoryToast() {
  const toast = useHistoryUi((s) => s.toast);
  const [dismissedNonce, setDismissedNonce] = useState(-1);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setDismissedNonce(toast.nonce), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast || toast.nonce === dismissedNonce) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-dark-brown/90 text-white text-sm px-4 py-2 shadow-lg pointer-events-none"
    >
      {toast.text}
    </div>
  );
}
