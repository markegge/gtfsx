import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useStore } from '../../store';
import {
  createThread,
  listCategories,
  type ForumCategory,
} from '../../services/forumApi';
import { ApiError } from '../../services/authApi';
import { Composer } from './Composer';

export function ComposeThread() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = useStore((s) => s.currentUser);

  const [cats, setCats] = useState<ForumCategory[]>([]);
  const initialCat = searchParams.get('category') ?? '';
  const [categoryId, setCategoryId] = useState(initialCat);
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCategories()
      .then(({ categories }) => {
        if (cancelled) return;
        setCats(categories);
        if (!categoryId && categories.length > 0) {
          const firstPostable = categories.find((c) => !c.locked) ?? categories[0];
          setCategoryId(firstPostable.id);
        }
      })
      .catch(() => {
        // ignore — error surfaces on submit
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount — initial categoryId is read from the URL and we
    // only want to fall back to the first postable category when no
    // category was preselected. Re-running when categoryId changes would
    // overwrite the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lockedForUser = useMemo(() => {
    const cat = cats.find((c) => c.id === categoryId);
    if (!cat) return false;
    return cat.locked && !currentUser?.staff;
  }, [cats, categoryId, currentUser]);

  if (!currentUser) {
    return (
      <div className="bg-white border border-sand rounded-lg p-6">
        <p className="text-sm text-warm-gray mb-2">Sign in to start a new thread.</p>
        <button
          onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}
          className="px-3 py-2 rounded-lg text-sm font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors"
        >
          Sign in
        </button>
      </div>
    );
  }

  const canSubmit = title.trim().length >= 8 && categoryId && !lockedForUser;

  const handleSubmit = async (bodyMd: string) => {
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      const { thread } = await createThread({
        categoryId,
        title: title.trim(),
        bodyMd,
      });
      navigate(`/community/${encodeURIComponent(thread.categoryId)}/${encodeURIComponent(thread.id)}-${thread.slug}`);
    } catch (e) {
      if (e instanceof ApiError && (e.extra as { reason?: string })?.reason === 'needs_display_name') {
        setError('Set a community display name before posting — it should have opened automatically.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not create thread');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Link to="/community" className="text-xs text-warm-gray hover:text-coral">← Cancel</Link>
        <h1 className="font-heading font-bold text-2xl text-dark-brown mt-1">New thread</h1>
      </div>

      <div className="bg-white border border-sand rounded-lg p-4 space-y-3">
        <div>
          <label className="block text-xs font-semibold text-warm-gray uppercase tracking-wide mb-1">Category</label>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="w-full px-3 py-2 border border-sand rounded-md text-sm bg-white outline-none focus:border-coral"
          >
            {cats.map((c) => (
              <option key={c.id} value={c.id} disabled={c.locked && !currentUser.staff}>
                {c.title}{c.locked && !currentUser.staff ? ' (admin only)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-warm-gray uppercase tracking-wide mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="A short, specific question or topic"
            maxLength={200}
            className="w-full px-3 py-2 border border-sand rounded-md text-sm outline-none focus:border-coral"
          />
          <p className="text-[11px] text-warm-gray mt-1">{title.length}/200</p>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">{error}</div>
      )}

      <Composer
        submitLabel={pending ? 'Posting…' : 'Post thread'}
        placeholder="What's your question or topic? Markdown is supported."
        onSubmit={handleSubmit}
        onCancel={() => navigate('/community')}
        disabled={pending || !canSubmit}
        minLength={2}
      />
    </div>
  );
}
