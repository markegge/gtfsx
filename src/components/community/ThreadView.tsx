import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  deleteThread,
  getMySubscription,
  getThread,
  patchThread,
  replyToThread,
  subscribeToThread,
  unsubscribeFromThread,
  type ForumPost,
  type ForumThread,
} from '../../services/forumApi';
import { markThreadSeen } from '../../services/forumReadState';
import { ApiError } from '../../services/authApi';
import { useStore } from '../../store';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { PostCard } from './PostCard';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { relativeTime } from './time';
import { threadPermalink } from './permalinks';

export function ThreadView() {
  const { threadKey } = useParams<{ catId: string; threadKey: string }>();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const currentUser = useStore((s) => s.currentUser);
  // threadKey is "<id>-<slug>"; pull the id off the front (ULIDs have no hyphens)
  const threadId = useMemo(() => {
    if (!threadKey) return null;
    return threadKey.split('-')[0] ?? null;
  }, [threadKey]);

  // Parse a post anchor out of the URL hash, e.g. "#post-01HN..." -> "01HN..."
  const anchorPostId = useMemo(() => {
    const m = hash.match(/^#post-(.+)$/);
    return m ? m[1] : null;
  }, [hash]);

  const [thread, setThread] = useState<ForumThread | null>(null);
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [replyPending, setReplyPending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyResetKey, setReplyResetKey] = useState(0);
  const [confirmDeleteThread, setConfirmDeleteThread] = useState(false);
  const [deletingThread, setDeletingThread] = useState(false);
  // Inline surface for thread-moderation failures (delete / pin / lock), in
  // place of a blocking alert().
  const [actionError, setActionError] = useState<string | null>(null);

  // Thread-level copy-link state
  const [threadLinkCopied, setThreadLinkCopied] = useState(false);
  // Which post (if any) is currently highlighted as the anchor target
  const [highlightedPostId, setHighlightedPostId] = useState<string | null>(null);
  // Guard: only auto-scroll once per mount even if posts re-renders
  const scrolledRef = useRef(false);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getThread(threadId);
        if (cancelled) return;
        setThread(res.thread);
        setPosts(res.posts);
        // Mark this thread seen so the category dot and thread-list row
        // styling update when the user navigates back.
        markThreadSeen(res.thread.id, res.thread.categoryId);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load thread');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    if (!threadId || !currentUser) {
      setSubscribed(null);
      return;
    }
    let cancelled = false;
    getMySubscription(threadId)
      .then(({ subscribed }) => {
        if (!cancelled) setSubscribed(subscribed);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, currentUser]);

  // Scroll to + briefly highlight the anchor post once posts have loaded.
  useEffect(() => {
    if (!anchorPostId || posts.length === 0 || scrolledRef.current) return;
    const el = document.getElementById(`post-${anchorPostId}`);
    if (!el) return;
    scrolledRef.current = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setHighlightedPostId(anchorPostId);
    const t = setTimeout(() => setHighlightedPostId(null), 2200);
    return () => clearTimeout(t);
  }, [anchorPostId, posts]);

  const handleCopyThreadLink = async () => {
    if (!thread) return;
    const url = threadPermalink(thread);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setThreadLinkCopied(true);
    setTimeout(() => setThreadLinkCopied(false), 1500);
  };

  if (error) {
    return (
      <div className="bg-white border border-sand rounded-lg p-6">
        <p className="text-sm text-red-700 mb-2">{error}</p>
        <Link to="/community" className="text-sm text-coral hover:text-coral">← Back to community</Link>
      </div>
    );
  }
  if (!thread) return <div className="text-warm-gray text-sm">Loading…</div>;

  const isAdmin = !!currentUser?.staff;
  const isAuthor = currentUser?.id === thread.author.id;

  const handleReply = async (md: string) => {
    if (!currentUser) {
      navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setReplyError(null);
    setReplyPending(true);
    try {
      const res = await replyToThread(thread.id, md);
      setPosts((prev) => [...prev, res.post]);
      setThread({ ...thread, postCount: thread.postCount + 1, lastPostAt: res.post.createdAt });
      // Remount the reply Composer (via key change) so its internal text resets
      // to empty — but ONLY on a successful post, so a failed post keeps the text.
      setReplyResetKey((k) => k + 1);
    } catch (e) {
      if (e instanceof ApiError && (e.extra as { reason?: string })?.reason === 'needs_display_name') {
        setReplyError('Set a community display name before posting — open the picker above.');
      } else {
        setReplyError(e instanceof Error ? e.message : 'Could not post reply');
      }
    } finally {
      setReplyPending(false);
    }
  };

  const handlePostUpdate = (updated: ForumPost) => {
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  const handlePostDelete = (postId: string) => {
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, deletedAt: Date.now(), bodyMd: '' } : p)));
    if (thread.solvedPostId === postId) setThread({ ...thread, solvedPostId: null });
  };

  const handleMarkSolved = (postId: string | null) => {
    setThread({ ...thread, solvedPostId: postId });
    setPosts((prev) => prev.map((p) => ({ ...p, isSolved: p.id === postId })));
  };

  const handleSubscribeToggle = async () => {
    if (!currentUser || !thread) return;
    try {
      const res = subscribed ? await unsubscribeFromThread(thread.id) : await subscribeToThread(thread.id);
      setSubscribed(res.subscribed);
    } catch {
      // ignore
    }
  };

  const performDeleteThread = async () => {
    setActionError(null);
    setDeletingThread(true);
    try {
      await deleteThread(thread.id);
      navigate(`/community/${encodeURIComponent(thread.categoryId)}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete thread');
      setConfirmDeleteThread(false);
    } finally {
      setDeletingThread(false);
    }
  };

  const handleAdminToggle = async (field: 'pinned' | 'locked') => {
    setActionError(null);
    try {
      const res = await patchThread(thread.id, { [field]: !thread[field] });
      setThread(res.thread);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update thread');
    }
  };

  const [op, ...replies] = posts;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-warm-gray">
            <Link to="/community" className="hover:text-coral">Community</Link>
            {' / '}
            <Link to={`/community/${encodeURIComponent(thread.categoryId)}`} className="hover:text-coral">
              {thread.categoryId}
            </Link>
          </div>
          <h1 className="font-heading font-bold text-2xl text-dark-brown mt-1 break-words">
            {thread.title}
          </h1>
          <div className="text-xs text-warm-gray mt-1 flex flex-wrap items-center gap-2">
            <Avatar gravatarHash={thread.author.gravatarHash} displayName={thread.author.displayName} size={20} />
            <span className="font-semibold text-dark-brown">{thread.author.displayName}</span>
            <span>·</span>
            <span>started {relativeTime(thread.createdAt)}</span>
            <span>·</span>
            <span>{thread.postCount} repl{thread.postCount === 1 ? 'y' : 'ies'}</span>
            {thread.solvedPostId && (
              <span className="text-teal font-semibold flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Solved
              </span>
            )}
            {thread.locked && <span className="italic">· Locked</span>}
            {thread.pinned && <span className="text-coral">· Pinned</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={handleCopyThreadLink}
            title="Copy link to this thread"
            aria-label="Copy link to this thread"
            className={`px-2 py-1 rounded-md text-xs border transition-colors flex items-center gap-1.5 ${
              threadLinkCopied
                ? 'border-teal text-teal'
                : 'border-sand hover:border-coral hover:text-coral'
            }`}
          >
            {threadLinkCopied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Copy link
              </>
            )}
          </button>
          {currentUser && (
            <>
              <button
                onClick={handleSubscribeToggle}
                className="px-2 py-1 rounded-md text-xs border border-sand hover:border-coral hover:text-coral transition-colors"
              >
                {subscribed ? '🔔 Unsubscribe' : '🔕 Subscribe'}
              </button>
              {(isAdmin || isAuthor) && (
                <button
                  onClick={() => setConfirmDeleteThread(true)}
                  className="px-2 py-1 rounded-md text-xs border border-sand text-warm-gray hover:border-red-300 hover:text-red-700 transition-colors"
                >
                  Delete thread
                </button>
              )}
              {isAdmin && (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleAdminToggle('pinned')}
                    className="px-2 py-1 rounded-md text-xs border border-sand hover:border-coral hover:text-coral transition-colors"
                  >
                    {thread.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    onClick={() => handleAdminToggle('locked')}
                    className="px-2 py-1 rounded-md text-xs border border-sand hover:border-coral hover:text-coral transition-colors"
                  >
                    {thread.locked ? 'Unlock' : 'Lock'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {actionError && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {actionError}
        </div>
      )}

      {op && (
        <PostCard
          post={op}
          thread={thread}
          isOp
          onUpdate={handlePostUpdate}
          onDelete={handlePostDelete}
          onMarkSolved={handleMarkSolved}
          isHighlighted={highlightedPostId === op.id}
        />
      )}

      {/* If there's an accepted answer that isn't the OP, hoist it to the top of the replies. */}
      {(() => {
        const ordered = orderReplies(replies, thread.solvedPostId);
        return ordered.map((p) => (
          <PostCard
            key={p.id}
            post={p}
            thread={thread}
            isOp={false}
            onUpdate={handlePostUpdate}
            onDelete={handlePostDelete}
            onMarkSolved={handleMarkSolved}
            isHighlighted={highlightedPostId === p.id}
          />
        ));
      })()}

      <div className="mt-4">
        {thread.locked ? (
          <div className="bg-sand/40 border border-sand rounded-lg p-4 text-sm text-warm-gray italic">
            This thread is locked — replies are closed.
          </div>
        ) : currentUser ? (
          <>
            {replyError && (
              <div className="mb-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                {replyError}
              </div>
            )}
            <Composer
              key={`reply-${replyResetKey}`}
              submitLabel={replyPending ? 'Posting…' : 'Post reply'}
              onSubmit={handleReply}
              disabled={replyPending}
            />
          </>
        ) : (
          <div className="bg-white border border-sand rounded-lg p-4 text-sm text-warm-gray flex items-center gap-3">
            <span className="flex-1">
              Sign in to join the conversation.
            </span>
            <button
              onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}
              className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors"
            >
              Sign in
            </button>
          </div>
        )}
      </div>

      {confirmDeleteThread && (
        <ConfirmDialog
          danger
          title="Delete this thread?"
          body="Delete this thread? This cannot be undone."
          confirmLabel="Delete thread"
          onConfirm={performDeleteThread}
          onCancel={() => setConfirmDeleteThread(false)}
          busy={deletingThread}
        />
      )}
    </div>
  );
}

function orderReplies(replies: ForumPost[], solvedPostId: string | null): ForumPost[] {
  if (!solvedPostId) return replies;
  const solved = replies.find((p) => p.id === solvedPostId);
  if (!solved) return replies;
  return [solved, ...replies.filter((p) => p.id !== solvedPostId)];
}
