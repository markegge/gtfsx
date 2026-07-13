import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { AdminLayout } from './AdminLayout';
import { AuthButton } from '../auth/AuthButton';
import { ConfirmDialog, ErrorBanner, StatusPill } from './adminShared';
import { formatDateTime } from './adminFormat';
import {
  impersonateUser,
  listAdminUsers,
  patchAdminUser,
  resendAdminUserVerification,
  softDeleteAdminUser,
  STAFF_IMPERSONATOR_KEY,
  type AdminUserRow,
  type UserStatus,
} from '../../services/adminApi';
import { ApiError } from '../../services/authApi';
import { useStore } from '../../store';

const STATUS_OPTIONS: { value: '' | UserStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'pending_verification', label: 'Pending verification' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'deleted_soft', label: 'Deleted (soft)' },
];

type PendingAction =
  | { type: 'toggleStatus'; user: AdminUserRow }
  | { type: 'toggleStaff'; user: AdminUserRow }
  | { type: 'resend'; user: AdminUserRow }
  | { type: 'delete'; user: AdminUserRow }
  | { type: 'impersonate'; user: AdminUserRow };

export function AdminUsersPage() {
  const navigate = useNavigate();
  const hydrateAuth = useStore((s) => s.hydrateAuth);

  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [status, setStatus] = useState<'' | UserStatus>('active');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAdminUsers({
        q: q || undefined,
        status: status || undefined,
        page,
        pageSize: 25,
      });
      setRows(res.users);
      setHasNext(res.nextCursor !== null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [q, status, page]);

  useEffect(() => {
    load();
  }, [load]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(qInput.trim());
  };

  const runPending = async () => {
    if (!pending) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (pending.type === 'toggleStatus') {
        const next = pending.user.status === 'active' ? 'disabled' : 'active';
        await patchAdminUser(pending.user.id, { status: next });
        setBanner(`${pending.user.email}: status set to ${next}`);
        setPending(null);
        await load();
      } else if (pending.type === 'toggleStaff') {
        await patchAdminUser(pending.user.id, { staff: !pending.user.staff });
        setBanner(
          `${pending.user.email}: staff ${pending.user.staff ? 'removed' : 'granted'}`,
        );
        setPending(null);
        await load();
      } else if (pending.type === 'resend') {
        await resendAdminUserVerification(pending.user.id);
        setBanner(`Verification email sent to ${pending.user.email}`);
        setPending(null);
      } else if (pending.type === 'delete') {
        await softDeleteAdminUser(pending.user.id);
        setBanner(`${pending.user.email} soft-deleted`);
        setPending(null);
        await load();
      } else if (pending.type === 'impersonate') {
        const staffId = useStore.getState().currentUser?.id;
        if (staffId) {
          localStorage.setItem(STAFF_IMPERSONATOR_KEY, staffId);
        }
        await impersonateUser(pending.user.id);
        await hydrateAuth();
        navigate('/feeds');
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <AdminLayout
      title="Users"
      subtitle="Search, filter, and take action on accounts. All actions are audited."
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

      <form onSubmit={onSearch} className="flex flex-wrap items-center gap-3 mb-5">
        <input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search by email substring…"
          aria-label="Search users by email substring"
          className="flex-1 min-w-[220px] px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as UserStatus | '');
            setPage(1);
          }}
          className="px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <AuthButton type="submit" variant="secondary">
          Search
        </AuthButton>
      </form>

      <ErrorBanner>{error}</ErrorBanner>

      <div className="bg-white border border-sand rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Staff</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Last session</th>
              <th className="px-4 py-3 text-right">Projects</th>
              <th className="px-4 py-3 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-warm-gray">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-warm-gray">
                  No users match.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((u) => (
                <tr key={u.id} className="border-t border-sand hover:bg-cream/40">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => navigate(`/admin/users/${encodeURIComponent(u.id)}`)}
                      className="text-coral font-semibold hover:underline"
                    >
                      {u.email}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-dark-brown">{u.displayName || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusPill status={u.status} />
                  </td>
                  <td className="px-4 py-3">
                    <PlanPill plan={u.plan} planStatus={u.planStatus} />
                  </td>
                  <td className="px-4 py-3">
                    {u.staff && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-dark-brown text-white">
                        staff
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-warm-gray">{formatDateTime(u.createdAt)}</td>
                  <td className="px-4 py-3 text-warm-gray">
                    {formatDateTime(u.lastSessionAt)}
                  </td>
                  <td className="px-4 py-3 text-right text-dark-brown">{u.projectCount}</td>
                  <td className="px-4 py-3">
                    <UserRowActions
                      user={u}
                      onSelect={(type) => {
                        setActionError(null);
                        setPending({ type, user: u } as PendingAction);
                      }}
                    />
                  </td>
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

      {pending && (
        <PendingConfirm
          action={pending}
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

export function UserRowActions({
  user,
  onSelect,
}: {
  user: AdminUserRow;
  onSelect: (type: PendingAction['type']) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="w-8 h-8 rounded-md text-warm-gray hover:text-coral hover:bg-cream flex items-center justify-center"
          aria-label="User actions"
          title="Actions"
        >
          •••
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="bg-white rounded-xl shadow-lg border border-sand p-1 w-52 z-50"
        >
          {user.status !== 'deleted_soft' && (
            <ActionItem onSelect={() => onSelect('toggleStatus')}>
              {user.status === 'active' ? 'Disable account' : 'Re-enable account'}
            </ActionItem>
          )}
          {user.status === 'pending_verification' && (
            <ActionItem onSelect={() => onSelect('resend')}>
              Resend verification
            </ActionItem>
          )}
          {user.status === 'active' && (
            <ActionItem onSelect={() => onSelect('impersonate')}>
              Impersonate
            </ActionItem>
          )}
          <ActionItem onSelect={() => onSelect('toggleStaff')} danger>
            {user.staff ? 'Remove staff' : 'Grant staff'}
          </ActionItem>
          {user.status !== 'deleted_soft' && (
            <ActionItem onSelect={() => onSelect('delete')} danger>
              Soft delete
            </ActionItem>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Mirrors StatusPill's visual weight. Color signals tier (gray free / coral
// pro / teal agency / dark-brown enterprise); a small grey suffix calls out
// non-active plan_status (past_due, canceled, trialing) so a delinquent
// pro subscriber doesn't visually look the same as a current one.
export function PlanPill({
  plan,
  planStatus,
}: {
  plan: AdminUserRow['plan'];
  planStatus: AdminUserRow['planStatus'];
}) {
  const styles: Record<AdminUserRow['plan'], string> = {
    free: 'bg-cream text-warm-gray border border-sand',
    agency: 'bg-teal-light text-teal',
    enterprise: 'bg-dark-brown text-white',
  };
  const statusSuffix: Record<AdminUserRow['planStatus'], string | null> = {
    active: null,
    past_due: 'past due',
    canceled: 'canceled',
    trialing: 'trial',
  };
  const suffix = statusSuffix[planStatus];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${styles[plan]}`}
      >
        {plan}
      </span>
      {suffix && (
        <span className="text-[10px] uppercase tracking-wide text-warm-gray">
          {suffix}
        </span>
      )}
    </span>
  );
}

function ActionItem({
  onSelect,
  children,
  danger = false,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Popover.Close asChild>
      <button
        onClick={onSelect}
        className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
          danger ? 'text-red-600 hover:bg-red-50' : 'text-dark-brown hover:bg-cream'
        }`}
      >
        {children}
      </button>
    </Popover.Close>
  );
}

function PendingConfirm({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: PendingAction;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const u = action.user;
  const cfg: Record<
    PendingAction['type'],
    { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean }
  > = {
    toggleStatus: {
      title: u.status === 'active' ? 'Disable account?' : 'Re-enable account?',
      body:
        u.status === 'active'
          ? `${u.email} won't be able to sign in. Active sessions are revoked.`
          : `${u.email} will be able to sign in again.`,
      confirmLabel: u.status === 'active' ? 'Disable' : 'Re-enable',
      danger: u.status === 'active',
    },
    toggleStaff: {
      title: u.staff ? 'Remove staff role?' : 'Grant staff role?',
      body: u.staff
        ? `${u.email} will lose access to the admin console.`
        : `${u.email} will gain full access to the admin console, including all user data and impersonation.`,
      confirmLabel: u.staff ? 'Remove staff' : 'Grant staff',
      danger: true,
    },
    resend: {
      title: 'Resend verification email?',
      body: `A fresh verification link will be sent to ${u.email}.`,
      confirmLabel: 'Send',
    },
    delete: {
      title: 'Soft delete account?',
      body: `${u.email} will be marked deleted and sessions revoked. Data is retained for recovery.`,
      confirmLabel: 'Delete',
      danger: true,
    },
    impersonate: {
      title: 'Impersonate this user?',
      body: `You'll sign in as ${u.email}. Your current staff session will be replaced. Use the red banner to exit.`,
      confirmLabel: 'Impersonate',
      danger: true,
    },
  };
  const c = cfg[action.type];
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
