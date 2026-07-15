import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { getMyForumProfile, patchMyForumProfile } from '../../services/forumApi';
import { Modal } from '../ui/Modal';
import { AuthButton } from '../auth/AuthButton';

// Sticky modal — appears on first visit to any /community/* page for any
// authed user without a forum display name set. The user can dismiss it,
// but the server-side write block is the real enforcement (every state-
// changing endpoint returns 412 needs_display_name until the name is set).

const DISMISSED_KEY = 'gtfs:forum:gate-dismissed-session';

export function DisplayNameGate({ children }: { children: React.ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);
  const [needsName, setNeedsName] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setNeedsName(false);
      return;
    }
    let cancelled = false;
    setNeedsName(null);
    getMyForumProfile()
      .then(({ profile }) => {
        if (cancelled) return;
        setNeedsName(profile.needsDisplayName);
        // Pre-fill with the account display name as a sensible default.
        setName(currentUser.displayName ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        setNeedsName(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  // Per-session dismissal so the modal doesn't trap the user on every page.
  useEffect(() => {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DISMISSED_KEY)) {
      setDismissed(true);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const { profile } = await patchMyForumProfile({ displayName: trimmed });
      setNeedsName(profile.needsDisplayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save display name');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
    setDismissed(true);
  };

  const showModal = !!currentUser && needsName === true && !dismissed;

  return (
    <>
      {children}
      {showModal && (
        <Modal
          open
          onClose={handleDismiss}
          showClose={false}
          maxWidthClassName="max-w-md"
          title="Pick your community name"
          description="This is how you'll appear on posts and replies. You can change it later in your profile."
        >
          <form onSubmit={handleSubmit}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your display name"
              maxLength={40}
              disabled={submitting}
              className="w-full px-3 py-2 border border-sand rounded-lg text-sm outline-none focus:border-coral mb-3"
            />
            {error && (
              <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs mb-3">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <AuthButton type="button" variant="secondary" fullWidth onClick={handleDismiss} disabled={submitting}>
                Skip for now
              </AuthButton>
              <AuthButton type="submit" fullWidth disabled={submitting || name.trim().length < 2}>
                {submitting ? 'Saving…' : 'Set name'}
              </AuthButton>
            </div>
            <p className="text-[11px] text-warm-gray mt-3">
              Posting and upvoting are blocked until you pick a name.
            </p>
          </form>
        </Modal>
      )}
    </>
  );
}
