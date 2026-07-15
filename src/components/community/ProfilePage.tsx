import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPublicProfile, banForumUser, unbanForumUser, type PublicProfile } from '../../services/forumApi';
import { useStore } from '../../store';
import { Avatar } from './Avatar';
import { relativeTime } from './time';
import { ConfirmDialog } from '../ui/ConfirmDialog';

const INDEFINITE_BAN_UNTIL = 4_102_444_800_000; // mirrors worker/forum/routes.ts

export function ProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentUser = useStore((s) => s.currentUser);
  const [banPending, setBanPending] = useState(false);
  const [banError, setBanError] = useState<string | null>(null);
  // Holds the pending confirmation's `currentlyBanned` value; null when closed.
  const [confirmBan, setConfirmBan] = useState<boolean | null>(null);

  async function performBan(currentlyBanned: boolean) {
    if (!userId) return;
    setBanPending(true);
    setBanError(null);
    try {
      const res = currentlyBanned ? await unbanForumUser(userId) : await banForumUser(userId);
      setData((prev) => (prev ? { ...prev, bannedUntil: res.bannedUntil } : prev));
      setConfirmBan(null);
    } catch (e) {
      setBanError(e instanceof Error ? e.message : 'Action failed');
      setConfirmBan(null);
    } finally {
      setBanPending(false);
    }
  }

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getPublicProfile(userId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load profile');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (error) return <div className="text-red-700 text-sm">{error}</div>;
  if (!data) return <div className="text-warm-gray text-sm">Loading…</div>;

  // Staff-only moderation. `bannedUntil` is only present in the response for
  // staff viewers; we also hide the control on the staff member's own profile.
  const showModeration = !!currentUser?.staff && currentUser.id !== userId;
  const bannedUntil = data.bannedUntil ?? null;
  const isBanned = typeof bannedUntil === 'number' && bannedUntil > Date.now();
  const indefinite = bannedUntil != null && bannedUntil >= INDEFINITE_BAN_UNTIL;

  return (
    <div className="space-y-6">
      <Link to="/community" className="text-xs text-warm-gray hover:text-coral">← Community</Link>
      <div className="bg-white border border-sand rounded-lg p-6 flex items-start gap-4">
        <Avatar gravatarHash={data.user.gravatarHash} displayName={data.user.displayName} size={72} />
        <div>
          <h1 className="font-heading font-bold text-2xl text-dark-brown">{data.user.displayName}</h1>
          <div className="text-sm text-warm-gray mt-1">
            {data.totalUpvotes} upvote{data.totalUpvotes === 1 ? '' : 's'} received across {data.threads.length + data.posts.length} contribution{data.threads.length + data.posts.length === 1 ? '' : 's'}.
          </div>
        </div>
      </div>

      {showModeration && (
        <div className={`rounded-lg border p-4 text-sm ${isBanned ? 'border-red-200 bg-red-50' : 'border-sand bg-white'}`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <span className="font-semibold text-dark-brown">Staff moderation</span>
              <span className="text-warm-gray">
                {' · '}
                {isBanned
                  ? indefinite
                    ? 'Banned from the forum (indefinite)'
                    : `Banned until ${new Date(bannedUntil!).toLocaleDateString()}`
                  : 'Forum access active'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setConfirmBan(isBanned)}
              disabled={banPending}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${
                isBanned ? 'bg-sand text-brown hover:bg-coral-light hover:text-coral' : 'bg-red-600 text-white hover:bg-red-700'
              }`}
            >
              {banPending ? '…' : isBanned ? 'Lift ban' : 'Ban from forum'}
            </button>
          </div>
          {banError && <div className="mt-2 text-red-700">{banError}</div>}
        </div>
      )}

      <section>
        <h2 className="font-heading font-bold text-sm text-warm-gray uppercase tracking-wide mb-2">Threads started</h2>
        {data.threads.length === 0 ? (
          <div className="bg-white border border-sand rounded-lg p-4 text-sm text-warm-gray">None yet.</div>
        ) : (
          <div className="bg-white border border-sand rounded-lg divide-y divide-sand">
            {data.threads.map((t) => (
              <Link
                key={t.id}
                to={`/community/${encodeURIComponent(t.categoryId)}/${encodeURIComponent(t.id)}-${t.slug}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-cream/40"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-dark-brown truncate">{t.title}</div>
                  <div className="text-xs text-warm-gray">{t.categoryId} · {relativeTime(t.createdAt)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-heading font-bold text-sm text-warm-gray uppercase tracking-wide mb-2">Recent replies</h2>
        {data.posts.length === 0 ? (
          <div className="bg-white border border-sand rounded-lg p-4 text-sm text-warm-gray">None yet.</div>
        ) : (
          <div className="bg-white border border-sand rounded-lg divide-y divide-sand">
            {data.posts.map((p) => (
              <Link
                key={p.id}
                to={`/community/${encodeURIComponent(p.categoryId)}/${encodeURIComponent(p.threadId)}-${p.threadSlug}#post-${p.id}`}
                className="flex items-start gap-3 px-4 py-3 hover:bg-cream/40"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-dark-brown truncate">{p.threadTitle}</div>
                  <div className="text-xs text-warm-gray truncate">
                    {p.upvoteCount} upvote{p.upvoteCount === 1 ? '' : 's'} · {relativeTime(p.createdAt)}
                  </div>
                  <p className="text-xs text-dark-brown/80 mt-1 line-clamp-2 truncate">{p.bodyMd.replace(/\s+/g, ' ').slice(0, 200)}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {confirmBan !== null && (
        <ConfirmDialog
          danger={!confirmBan}
          title={confirmBan ? 'Lift forum ban?' : 'Ban from forum?'}
          body={
            confirmBan
              ? "Lift this member's forum ban? They'll be able to post again."
              : "Ban this member from the forum? They won't be able to post until you lift it."
          }
          confirmLabel={confirmBan ? 'Lift ban' : 'Ban from forum'}
          onConfirm={() => performBan(confirmBan)}
          onCancel={() => setConfirmBan(null)}
          busy={banPending}
        />
      )}
    </div>
  );
}
