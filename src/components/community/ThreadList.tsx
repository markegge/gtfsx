import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listCategories, listThreads, type ForumCategory, type ForumThread } from '../../services/forumApi';
import { Avatar } from './Avatar';
import { relativeTime } from './time';

type SortMode = 'active' | 'new' | 'unanswered';

export function ThreadList() {
  const { catId } = useParams<{ catId: string }>();
  const navigate = useNavigate();
  const [cat, setCat] = useState<ForumCategory | null>(null);
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [sort, setSort] = useState<SortMode>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!catId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [catsRes, threadRes] = await Promise.all([
          listCategories(),
          listThreads({ category: catId, sort, limit: 50 }),
        ]);
        if (cancelled) return;
        const found = catsRes.categories.find((c) => c.id === catId) ?? null;
        setCat(found);
        setThreads(threadRes.threads);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load threads');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catId, sort]);

  if (error) return <div className="text-red-700 text-sm">{error}</div>;
  if (!cat && !loading) {
    return (
      <div className="bg-white border border-sand rounded-lg p-6">
        <p className="text-sm text-warm-gray">Category not found.</p>
        <Link to="/community" className="text-sm text-coral hover:underline">← Back to community</Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Link to="/community" className="text-xs text-warm-gray hover:text-coral">← All categories</Link>
          <h1 className="font-heading font-bold text-2xl text-dark-brown mt-1 truncate">{cat?.title}</h1>
          {cat?.description && <p className="text-sm text-warm-gray mt-1">{cat.description}</p>}
        </div>
        <button
          onClick={() => navigate(`/community/new?category=${encodeURIComponent(catId ?? '')}`)}
          className="px-3 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors shrink-0"
        >
          + New thread
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs">
        {(['active', 'new', 'unanswered'] as SortMode[]).map((s) => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={`px-3 py-1 rounded-full border transition-colors ${
              sort === s
                ? 'bg-coral border-coral text-white'
                : 'bg-white border-sand text-warm-gray hover:border-coral hover:text-coral'
            }`}
          >
            {s === 'active' ? 'Active' : s === 'new' ? 'Newest' : 'Unanswered'}
          </button>
        ))}
      </div>

      <div className="bg-white border border-sand rounded-lg divide-y divide-sand">
        {loading ? (
          <div className="p-6 text-warm-gray text-sm">Loading…</div>
        ) : threads.length === 0 ? (
          <div className="p-6 text-warm-gray text-sm">
            {sort === 'unanswered' ? 'No unanswered threads here — great!' : 'No threads yet. Start one above.'}
          </div>
        ) : (
          threads.map((t) => <ThreadRow key={t.id} t={t} />)
        )}
      </div>
    </div>
  );
}

function ThreadRow({ t }: { t: ForumThread }) {
  return (
    <Link
      to={`/community/${encodeURIComponent(t.categoryId)}/${encodeURIComponent(t.id)}-${t.slug}`}
      className="flex items-start gap-3 px-4 py-3 hover:bg-cream/40 transition-colors"
    >
      <Avatar gravatarHash={t.author.gravatarHash} displayName={t.author.displayName} size={32} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-dark-brown truncate">
          {t.pinned && <span className="text-[10px] uppercase tracking-wide text-coral shrink-0">Pinned</span>}
          {t.locked && <span className="text-[10px] uppercase tracking-wide text-warm-gray shrink-0">Locked</span>}
          {t.solvedPostId && <span className="text-[10px] uppercase tracking-wide text-teal shrink-0">Solved</span>}
          <span className="truncate">{t.title}</span>
        </div>
        {t.opExcerpt && (
          <div className="text-xs text-warm-gray mt-0.5 line-clamp-2">
            {t.opExcerpt}
          </div>
        )}
        <div className="text-xs text-warm-gray mt-1">
          {t.author.displayName} · {t.postCount} repl{t.postCount === 1 ? 'y' : 'ies'} · {relativeTime(t.lastPostAt)}
        </div>
      </div>
    </Link>
  );
}
