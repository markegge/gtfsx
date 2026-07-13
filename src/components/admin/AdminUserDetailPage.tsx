import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AdminLayout } from './AdminLayout';
import { ConfirmDialog, ErrorBanner, StatusPill } from './adminShared';
import { formatDateTime } from './adminFormat';
import { UserRowActions } from './AdminUsersPage';
import { PlanGrantCard } from './PlanGrantCard';
import {
  getAdminUser,
  impersonateUser,
  patchAdminUser,
  resendAdminUserVerification,
  softDeleteAdminUser,
  STAFF_IMPERSONATOR_KEY,
  type AdminUserDetailResponse,
} from '../../services/adminApi';
import { ApiError } from '../../services/authApi';
import { useStore } from '../../store';

type ActionType = 'toggleStatus' | 'toggleStaff' | 'resend' | 'delete' | 'impersonate';

export function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const hydrateAuth = useStore((s) => s.hydrateAuth);

  const [data, setData] = useState<AdminUserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ActionType | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminUser(id);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const runPending = async () => {
    if (!pending || !data) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const u = data.user;
      if (pending === 'toggleStatus') {
        const next = u.status === 'active' ? 'disabled' : 'active';
        await patchAdminUser(u.id, { status: next });
        setBanner(`Status set to ${next}`);
      } else if (pending === 'toggleStaff') {
        await patchAdminUser(u.id, { staff: !u.staff });
        setBanner(`Staff ${u.staff ? 'removed' : 'granted'}`);
      } else if (pending === 'resend') {
        await resendAdminUserVerification(u.id);
        setBanner('Verification email sent');
      } else if (pending === 'delete') {
        await softDeleteAdminUser(u.id);
        setBanner('Account soft-deleted');
      } else if (pending === 'impersonate') {
        const staffId = useStore.getState().currentUser?.id;
        if (staffId) localStorage.setItem(STAFF_IMPERSONATOR_KEY, staffId);
        await impersonateUser(u.id);
        await hydrateAuth();
        navigate('/feeds');
        return;
      }
      setPending(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <AdminLayout
      title="User details"
      subtitle={
        <Link to="/admin/users" className="text-coral hover:underline">
          ← Back to users
        </Link>
      }
    >
      {banner && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-teal-light text-teal border border-teal/30 text-sm flex items-center gap-3">
          <span className="flex-1">{banner}</span>
          <button
            onClick={() => setBanner(null)}
            className="w-7 h-7 rounded-md hover:bg-white/50"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <ErrorBanner>{error}</ErrorBanner>

      {loading && !data && <p className="text-sm text-warm-gray">Loading…</p>}

      {data && (
        <div className="space-y-5">
          <div className="bg-white border border-sand rounded-2xl p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="font-heading font-bold text-xl text-dark-brown">
                    {data.user.email}
                  </h2>
                  <StatusPill status={data.user.status} />
                  {data.user.staff && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-dark-brown text-white">
                      staff
                    </span>
                  )}
                </div>
                <div className="text-sm text-warm-gray">
                  {data.user.displayName || '—'} · Created{' '}
                  {formatDateTime(data.user.createdAt)}
                </div>
                <div className="text-xs text-warm-gray mt-1 font-mono">{data.user.id}</div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right text-sm text-warm-gray">
                  <div>
                    Last session:{' '}
                    <span className="text-dark-brown">
                      {formatDateTime(data.user.lastSessionAt)}
                    </span>
                  </div>
                  <div>
                    Projects:{' '}
                    <span className="text-dark-brown">{data.user.projectCount}</span>
                  </div>
                </div>
                <UserRowActions
                  user={data.user}
                  onSelect={(type) => {
                    setActionError(null);
                    setPending(type);
                  }}
                />
              </div>
            </div>
          </div>

          <PlanGrantCard
            kind="user"
            id={data.user.id}
            plan={data.user.plan}
            planStatus={data.user.planStatus}
            planExpiresAt={data.user.planExpiresAt ?? null}
            onChanged={load}
          />

          <section>
            <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">
              Memberships
            </h3>
            <div className="bg-white border border-sand rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
                    <th className="px-4 py-3">Organization</th>
                    <th className="px-4 py-3">Slug</th>
                    <th className="px-4 py-3">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {data.memberships.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-warm-gray">
                        Not a member of any organization.
                      </td>
                    </tr>
                  )}
                  {data.memberships.map((m) => (
                    <tr key={m.orgId} className="border-t border-sand hover:bg-cream/40">
                      <td className="px-4 py-3">
                        <Link
                          to={`/admin/orgs/${encodeURIComponent(m.orgId)}`}
                          className="text-coral font-semibold hover:underline"
                        >
                          {m.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-warm-gray font-mono text-xs">{m.slug}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-sand text-brown">
                          {m.role}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">
              Recent audit events
            </h3>
            <div className="bg-white border border-sand rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Subject</th>
                    <th className="px-4 py-3">IP</th>
                    <th className="px-4 py-3">Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {data.auditEvents.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-warm-gray">
                        No audit events.
                      </td>
                    </tr>
                  )}
                  {data.auditEvents.map((e) => (
                    <tr key={e.id} className="border-t border-sand hover:bg-cream/40 align-top">
                      <td className="px-4 py-3 text-warm-gray whitespace-nowrap">
                        {formatDateTime(e.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-dark-brown font-mono text-xs">
                        {e.action}
                      </td>
                      <td className="px-4 py-3 text-warm-gray text-xs">
                        {e.subjectType}
                        {e.subjectId ? ` · ${e.subjectId.slice(0, 8)}` : ''}
                      </td>
                      <td className="px-4 py-3 text-warm-gray text-xs font-mono">
                        {e.ip || '—'}
                      </td>
                      <td className="px-4 py-3 text-warm-gray text-xs font-mono max-w-[320px] break-words">
                        {e.metadataJson || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {pending && data && (
        <PendingUserConfirm
          type={pending}
          user={data.user}
          busy={actionBusy}
          error={actionError}
          onCancel={() => {
            setPending(null);
            setActionError(null);
          }}
          onConfirm={runPending}
        />
      )}
    </AdminLayout>
  );
}

function PendingUserConfirm({
  type,
  user,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  type: ActionType;
  user: { email: string; status: string; staff: boolean };
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cfg = {
    toggleStatus: {
      title: user.status === 'active' ? 'Disable account?' : 'Re-enable account?',
      body:
        user.status === 'active'
          ? `${user.email} won't be able to sign in. Active sessions are revoked.`
          : `${user.email} will be able to sign in again.`,
      confirmLabel: user.status === 'active' ? 'Disable' : 'Re-enable',
      danger: user.status === 'active',
    },
    toggleStaff: {
      title: user.staff ? 'Remove staff role?' : 'Grant staff role?',
      body: user.staff
        ? `${user.email} will lose access to the admin console.`
        : `${user.email} will gain full admin-console access.`,
      confirmLabel: user.staff ? 'Remove staff' : 'Grant staff',
      danger: true,
    },
    resend: {
      title: 'Resend verification email?',
      body: `A fresh verification link will be sent to ${user.email}.`,
      confirmLabel: 'Send',
      danger: false,
    },
    delete: {
      title: 'Soft delete account?',
      body: `${user.email} will be marked deleted and sessions revoked.`,
      confirmLabel: 'Delete',
      danger: true,
    },
    impersonate: {
      title: 'Impersonate this user?',
      body: `You'll sign in as ${user.email}. Your current staff session will be replaced.`,
      confirmLabel: 'Impersonate',
      danger: true,
    },
  } as const;
  const c = cfg[type];
  return (
    <ConfirmDialog
      title={c.title}
      body={
        <>
          <p className="mb-2">{c.body}</p>
          {error && (
            <p className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
              {error}
            </p>
          )}
        </>
      }
      confirmLabel={c.confirmLabel}
      danger={c.danger}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

