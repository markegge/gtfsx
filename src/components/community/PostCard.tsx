import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../../store';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';
import { UpvoteButton } from './UpvoteButton';
import { MarkSolvedButton } from './MarkSolvedButton';
import { Composer } from './Composer';
import { relativeTime } from './time';
import { editPost, deletePost, type ForumPost, type ForumThread } from '../../services/forumApi';
import { postPermalink } from './permalinks';

interface PostCardProps {
  post: ForumPost;
  thread: ForumThread;
  isOp: boolean;             // true for the original post in the thread
  onUpdate: (p: ForumPost) => void;
  onDelete: (postId: string) => void;
  onMarkSolved: (postId: string | null) => void;
  /** When true the card renders with a brief coral highlight ring (anchor target). */
  isHighlighted?: boolean;
}

export function PostCard({ post, thread, isOp, onUpdate, onDelete, onMarkSolved, isHighlighted = false }: PostCardProps) {
  const currentUser = useStore((s) => s.currentUser);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyLink = async () => {
    const url = postPermalink(thread, post.id);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback: create a temporary input (execCommand is deprecated but broadly supported)
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isAuthor = currentUser?.id === post.author.id;
  const isAdmin = !!currentUser?.staff;
  const isThreadAuthor = currentUser?.id === thread.author.id;

  const canEdit = (isAdmin || (isAuthor && Date.now() - post.createdAt < 30 * 60 * 1000)) && !post.deletedAt;
  const canDelete = (isAdmin || isAuthor) && !post.deletedAt && !isOp;
  const canMarkSolved = !isOp && !post.deletedAt && (isAdmin || isThreadAuthor);

  if (post.deletedAt) {
    return (
      <div className="bg-sand/30 border border-sand rounded-lg p-4 text-warm-gray italic text-sm" id={`post-${post.id}`}>
        This post was deleted.
      </div>
    );
  }

  const handleSaveEdit = async (md: string) => {
    setPending(true);
    try {
      const res = await editPost(post.id, md);
      onUpdate(res.post);
      setEditing(false);
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async () => {
    setPending(true);
    try {
      await deletePost(post.id);
      onDelete(post.id);
    } finally {
      setPending(false);
    }
  };

  return (
    <article
      id={`post-${post.id}`}
      className={`bg-white border rounded-lg p-4 scroll-mt-20 transition-shadow ${
        isHighlighted
          ? 'border-coral/40 ring-2 ring-coral/30'
          : post.isSolved
            ? 'border-teal/40 ring-1 ring-teal/30'
            : 'border-sand'
      }`}
    >
      {post.isSolved && (
        <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-teal">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Accepted answer
        </div>
      )}
      <div className="flex gap-3">
        <div className="shrink-0">
          <UpvoteButton
            postId={post.id}
            authorId={post.author.id}
            initialCount={post.upvoteCount}
            initialUpvoted={post.upvotedByMe}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs text-warm-gray mb-2">
            <Link to={`/community/u/${encodeURIComponent(post.author.id)}`} className="flex items-center gap-2 hover:text-coral">
              <Avatar gravatarHash={post.author.gravatarHash} displayName={post.author.displayName} size={24} />
              <span className="font-semibold text-dark-brown">{post.author.displayName}</span>
            </Link>
            <span>·</span>
            <span title={new Date(post.createdAt).toLocaleString()}>{relativeTime(post.createdAt)}</span>
            {post.editedAt && (
              <span title={`Edited ${new Date(post.editedAt).toLocaleString()}`} className="italic">edited</span>
            )}
            <button
              onClick={handleCopyLink}
              title="Copy link to this post"
              aria-label="Copy link to this post"
              className={`ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                copied ? 'text-teal' : 'hover:text-coral'
              }`}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              <span className="sr-only">{copied ? 'Copied' : 'Copy link'}</span>
              {copied && <span aria-live="polite" className="text-[10px] font-semibold">Copied</span>}
            </button>
          </div>

          {editing ? (
            <Composer
              key={`edit-${post.id}`}
              initial={post.bodyMd}
              submitLabel={pending ? 'Saving…' : 'Save changes'}
              onSubmit={handleSaveEdit}
              onCancel={() => setEditing(false)}
              disabled={pending}
            />
          ) : (
            <div className="text-sm text-dark-brown">
              <Markdown>{post.bodyMd}</Markdown>
            </div>
          )}

          {!editing && (canEdit || canDelete || canMarkSolved) && (
            <div className="flex items-center gap-3 mt-3 text-xs text-warm-gray">
              {canMarkSolved && (
                <MarkSolvedButton
                  postId={post.id}
                  isCurrentlySolved={post.isSolved}
                  threadSolvedPostId={thread.solvedPostId}
                  threadId={thread.id}
                  onChange={onMarkSolved}
                />
              )}
              {canEdit && (
                <button
                  onClick={() => setEditing(true)}
                  className="hover:text-coral"
                >
                  Edit
                </button>
              )}
              {canDelete && (
                confirmDelete ? (
                  <span className="flex items-center gap-2">
                    <span className="text-red-700">Delete this post?</span>
                    <button onClick={handleDelete} disabled={pending} className="text-red-700 font-semibold hover:underline">Yes</button>
                    <button onClick={() => setConfirmDelete(false)} className="hover:text-coral">No</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDelete(true)} className="hover:text-red-700">Delete</button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
