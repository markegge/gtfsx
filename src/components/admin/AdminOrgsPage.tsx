import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminLayout } from './AdminLayout';
import { AuthButton } from '../auth/AuthButton';
import { ErrorBanner } from './adminShared';
import { formatDateTime } from './adminFormat';
import { listAdminOrgs, type AdminOrgRow } from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

export function AdminOrgsPage() {
  const navigate = useNavigate();

  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminOrgRow[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAdminOrgs({
        q: q || undefined,
        page,
        pageSize: 25,
      });
      setRows(res.orgs);
      setHasNext(res.nextCursor !== null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load organizations');
    } finally {
      setLoading(false);
    }
  }, [q, page]);

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  };

  return (
    <AdminLayout title="Organizations" subtitle="Search orgs and manage memberships.">
      <form onSubmit={onSearch} className="flex flex-wrap items-center gap-3 mb-5">
        <input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search by slug or name…"
          aria-label="Search organizations by slug or name"
          className="flex-1 min-w-[220px] px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
        />
        <AuthButton type="submit" variant="secondary">
          Search
        </AuthButton>
      </form>

      <ErrorBanner>{error}</ErrorBanner>

      <div className="bg-white border border-sand rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3 text-right">Members</th>
              <th className="px-4 py-3 text-right">Projects</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-warm-gray">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-warm-gray">
                  No organizations match.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((o) => (
                <tr key={o.id} className="border-t border-sand hover:bg-cream/40">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => navigate(`/admin/orgs/${encodeURIComponent(o.id)}`)}
                      className="text-coral font-semibold hover:underline"
                    >
                      {o.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-warm-gray font-mono text-xs">{o.slug}</td>
                  <td className="px-4 py-3 text-right text-dark-brown">{o.memberCount}</td>
                  <td className="px-4 py-3 text-right text-dark-brown">{o.projectCount}</td>
                  <td className="px-4 py-3 text-warm-gray">{formatDateTime(o.createdAt)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm">
        <div className="text-warm-gray">Page {page}</div>
        <div className="flex gap-2">
          <AuthButton
            variant="secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
          >
            Previous
          </AuthButton>
          <AuthButton
            variant="secondary"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext || loading}
          >
            Next
          </AuthButton>
        </div>
      </div>
    </AdminLayout>
  );
}
