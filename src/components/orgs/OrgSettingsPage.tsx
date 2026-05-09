import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { RoleBadge } from '../layout/TopBar';
import { ApiError } from '../../services/authApi';
import {
  createInvitation,
  deleteOrg,
  deleteOrgLogo,
  getOrg,
  listInvitations,
  orgLogoUrl,
  patchOrg,
  removeMember,
  rescindInvitation,
  roleAtLeast,
  transferOwnership,
  updateMemberRole,
  uploadOrgLogo,
  type InviteRole,
  type OrgDetail,
  type OrgInfo,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
} from '../../services/orgsApi';

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function OrgSettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const userOrgs = useStore((s) => s.userOrgs);
  const orgsLoaded = useStore((s) => s.orgsLoaded);
  const loadOrgs = useStore((s) => s.loadOrgs);
  const upsertUserOrg = useStore((s) => s.upsertUserOrg);
  const removeUserOrg = useStore((s) => s.removeUserOrg);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);

  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [myRole, setMyRole] = useState<OrgRole | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingMeta, setEditingMeta] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<OrgMember | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  useEffect(() => {
    if (!authChecked) return;
    if (!orgsLoaded && currentUser) loadOrgs();
  }, [authChecked, orgsLoaded, currentUser, loadOrgs]);

  // Resolve slug → org summary to find the id and my role quickly.
  const matchingOrg = useMemo(
    () => userOrgs.find((o) => o.slug === slug) ?? null,
    [userOrgs, slug],
  );

  const fetchDetail = useCallback(
    async (orgId: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const d = await getOrg(orgId);
        setDetail(d);
        // Infer my role from members list.
        const me = d.members.find((m) => m.userId === currentUser?.id);
        setMyRole(me?.role ?? null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setLoadError('not_member');
        } else {
          const msg = err instanceof ApiError ? err.message : 'Could not load organization';
          setLoadError(msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [currentUser?.id],
  );

  useEffect(() => {
    if (!authChecked || !currentUser) return;
    if (!orgsLoaded) return;
    if (!matchingOrg) {
      setLoading(false);
      setLoadError('not_member');
      return;
    }
    fetchDetail(matchingOrg.id);
  }, [authChecked, currentUser, orgsLoaded, matchingOrg, fetchDetail]);

  const refreshInvitations = useCallback(async () => {
    if (!detail) return;
    if (!myRole || !roleAtLeast(myRole, 'admin')) {
      setInvitations([]);
      return;
    }
    try {
      const { invitations: invs } = await listInvitations(detail.organization.id);
      setInvitations(invs);
    } catch {
      setInvitations([]);
    }
  }, [detail, myRole]);

  useEffect(() => {
    refreshInvitations();
  }, [refreshInvitations]);

  if (!authChecked || (loading && !loadError)) {
    return (
      <AuthLayout title="Organization">
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!currentUser) {
    navigate(
      `/login?next=${encodeURIComponent(`/orgs/${slug ?? ''}`)}`,
      { replace: true },
    );
    return null;
  }

  if (loadError === 'not_member' || !detail) {
    return (
      <AuthLayout
        title="Organization"
        subtitle="You don't have access to this organization."
      >
        <div className="flex justify-end">
          <AuthButton onClick={() => navigate('/feeds')}>Back to My Feeds</AuthButton>
        </div>
      </AuthLayout>
    );
  }

  const isAdmin = myRole ? roleAtLeast(myRole, 'admin') : false;
  const isOwner = myRole === 'owner';
  const org = detail.organization;

  const handleSaveMeta = async (name: string, newSlug: string) => {
    try {
      const { organization } = await patchOrg(org.id, {
        name: name !== org.name ? name : undefined,
        slug: newSlug !== org.slug ? newSlug : undefined,
      });
      setDetail({ ...detail, organization });
      upsertUserOrg({
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        role: myRole ?? 'viewer',
        memberCount: detail.members.length,
        projectCount: detail.projectCount,
        createdAt: organization.createdAt,
      });
      setEditingMeta(false);
      if (organization.slug !== slug) {
        navigate(`/orgs/${encodeURIComponent(organization.slug)}`, { replace: true });
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save';
      setActionError(msg);
    }
  };

  const handleChangeRole = async (member: OrgMember, role: OrgRole) => {
    setActionError(null);
    try {
      await updateMemberRole(org.id, member.userId, { role });
      setDetail({
        ...detail,
        members: detail.members.map((m) =>
          m.userId === member.userId ? { ...m, role } : m,
        ),
      });
      if (member.userId === currentUser.id) setMyRole(role);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not change role';
      setActionError(msg);
    }
  };

  const handleRemoveMember = async (member: OrgMember) => {
    setActionError(null);
    try {
      await removeMember(org.id, member.userId);
      const isSelf = member.userId === currentUser.id;
      if (isSelf) {
        removeUserOrg(org.id);
        if (
          activeWorkspace.type === 'org' &&
          activeWorkspace.orgId === org.id
        ) {
          setActiveWorkspace({ type: 'personal' });
        }
        navigate('/feeds');
        return;
      }
      setDetail({
        ...detail,
        members: detail.members.filter((m) => m.userId !== member.userId),
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not remove member';
      setActionError(msg);
    }
  };

  const handleInvite = async (email: string, role: InviteRole) => {
    setActionError(null);
    await createInvitation(org.id, { email, role });
    await refreshInvitations();
  };

  const handleRescind = async (tokenHash: string) => {
    setActionError(null);
    try {
      await rescindInvitation(org.id, tokenHash);
      setInvitations((list) => list.filter((i) => i.tokenHash !== tokenHash));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not rescind';
      setActionError(msg);
    }
  };

  const handleTransfer = async (newOwnerUserId: string) => {
    setActionError(null);
    try {
      await transferOwnership(org.id, { newOwnerUserId });
      // Refresh membership list.
      const fresh = await getOrg(org.id);
      setDetail(fresh);
      const me = fresh.members.find((m) => m.userId === currentUser.id);
      setMyRole(me?.role ?? null);
      if (me) {
        upsertUserOrg({
          id: fresh.organization.id,
          slug: fresh.organization.slug,
          name: fresh.organization.name,
          role: me.role,
          memberCount: fresh.members.length,
          projectCount: fresh.projectCount,
          createdAt: fresh.organization.createdAt,
        });
      }
      setShowTransfer(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not transfer';
      setActionError(msg);
    }
  };

  const handleDeleteOrg = async () => {
    setActionError(null);
    try {
      await deleteOrg(org.id);
      removeUserOrg(org.id);
      if (
        activeWorkspace.type === 'org' &&
        activeWorkspace.orgId === org.id
      ) {
        setActiveWorkspace({ type: 'personal' });
      }
      navigate('/feeds');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not delete organization';
      setActionError(msg);
    }
  };

  return (
    <div className="min-h-full bg-cream">
      <header className="h-14 bg-white border-b border-sand flex items-center px-5 shrink-0">
        <Link
          to="/"
          className="flex items-center gap-2 font-heading font-extrabold text-xl text-coral hover:opacity-80 transition-opacity"
        >
          GTFS Builder
        </Link>
        <div className="flex-1" />
        <Link to="/feeds" className="text-sm text-warm-gray hover:text-coral transition-colors">
          ← My Feeds
        </Link>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="bg-white border border-sand rounded-2xl p-6 mb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h1 className="font-heading font-extrabold text-2xl text-dark-brown">
                  {org.name}
                </h1>
                {myRole && <RoleBadge role={myRole} />}
              </div>
              <div className="text-xs text-warm-gray font-mono">{org.slug}</div>
              <div className="text-sm text-warm-gray mt-2">
                {detail.members.length} member{detail.members.length === 1 ? '' : 's'} ·{' '}
                {detail.projectCount} feed{detail.projectCount === 1 ? '' : 's'}
              </div>
            </div>
            {isAdmin && (
              <button
                onClick={() => setEditingMeta(true)}
                className="w-9 h-9 rounded-md text-warm-gray hover:text-coral hover:bg-cream"
                aria-label="Edit organization"
                title="Edit"
              >
                ✎
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {actionError}
          </div>
        )}

        <BrandingSection
          org={org}
          canEdit={isAdmin}
          onUpdated={(updated) => {
            setDetail((prev) => (prev ? { ...prev, organization: updated } : prev));
          }}
        />

        <section className="bg-white border border-sand rounded-2xl p-6 mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading font-bold text-lg text-dark-brown">Members</h2>
            {isAdmin && (
              <AuthButton onClick={() => setShowInvite(true)}>+ Invite</AuthButton>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-warm-gray border-b border-sand">
                <th className="pb-2 font-semibold">Member</th>
                <th className="pb-2 font-semibold">Role</th>
                <th className="pb-2 font-semibold">Joined</th>
                <th className="pb-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {detail.members.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  myUserId={currentUser.id}
                  myRole={myRole}
                  onChangeRole={(role) => handleChangeRole(m, role)}
                  onLeave={() => setLeaveTarget(m)}
                  onRemove={() => setRemoveTarget(m)}
                />
              ))}
            </tbody>
          </table>
        </section>

        {isAdmin && (
          <section className="bg-white border border-sand rounded-2xl p-6 mb-5">
            <h2 className="font-heading font-bold text-lg text-dark-brown mb-4">
              Pending invitations
            </h2>
            {invitations.length === 0 ? (
              <p className="text-sm text-warm-gray">No pending invitations.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-warm-gray border-b border-sand">
                    <th className="pb-2 font-semibold">Email</th>
                    <th className="pb-2 font-semibold">Role</th>
                    <th className="pb-2 font-semibold">Expires</th>
                    <th className="pb-2 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((inv) => (
                    <tr key={inv.tokenHash} className="border-b border-sand/50 last:border-0">
                      <td className="py-2 text-dark-brown">{inv.email ?? '—'}</td>
                      <td className="py-2">
                        <RoleBadge role={inv.role} />
                      </td>
                      <td className="py-2 text-warm-gray">{formatDate(inv.expiresAt)}</td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => handleRescind(inv.tokenHash)}
                          className="text-xs text-red-600 hover:text-red-700 hover:underline"
                        >
                          Rescind
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {isOwner && (
          <section className="bg-white border border-sand rounded-2xl p-6 mb-5">
            <h2 className="font-heading font-bold text-lg text-dark-brown mb-2">
              Transfer ownership
            </h2>
            <p className="text-sm text-warm-gray mb-3">
              Promote another member to owner. You'll become an admin.
            </p>
            <AuthButton
              variant="secondary"
              onClick={() => setShowTransfer(true)}
              disabled={detail.members.filter((m) => m.userId !== currentUser.id).length === 0}
            >
              Transfer ownership…
            </AuthButton>
          </section>
        )}

        {isOwner && (
          <section className="bg-white border border-red-200 rounded-2xl p-6">
            <h2 className="font-heading font-bold text-lg text-red-700 mb-2">
              Delete organization
            </h2>
            <p className="text-sm text-warm-gray mb-3">
              This will permanently remove the organization and its feeds. This can't be undone.
            </p>
            <AuthButton variant="danger" onClick={() => setShowDelete(true)}>
              Delete organization
            </AuthButton>
          </section>
        )}
      </main>

      {editingMeta && (
        <EditOrgDialog
          initialName={org.name}
          initialSlug={org.slug}
          onCancel={() => setEditingMeta(false)}
          onSave={handleSaveMeta}
        />
      )}

      {showInvite && (
        <InviteDialog
          canInviteAdmin={isOwner}
          onClose={() => setShowInvite(false)}
          onInvite={handleInvite}
        />
      )}

      {showTransfer && (
        <TransferDialog
          members={detail.members.filter((m) => m.userId !== currentUser.id)}
          onCancel={() => setShowTransfer(false)}
          onConfirm={handleTransfer}
        />
      )}

      {showDelete && (
        <DeleteOrgDialog
          slug={org.slug}
          onCancel={() => setShowDelete(false)}
          onConfirm={handleDeleteOrg}
        />
      )}

      {leaveTarget && (
        <ConfirmDialog
          title="Leave organization?"
          body={`You'll lose access to ${org.name}.`}
          confirmLabel="Leave"
          danger
          onCancel={() => setLeaveTarget(null)}
          onConfirm={async () => {
            const target = leaveTarget;
            setLeaveTarget(null);
            await handleRemoveMember(target);
          }}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Remove member?"
          body={`${removeTarget.email} will lose access to this organization.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            const target = removeTarget;
            setRemoveTarget(null);
            await handleRemoveMember(target);
          }}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  myUserId,
  myRole,
  onChangeRole,
  onLeave,
  onRemove,
}: {
  member: OrgMember;
  myUserId: string;
  myRole: OrgRole | null;
  onChangeRole: (role: OrgRole) => void;
  onLeave: () => void;
  onRemove: () => void;
}) {
  const isSelf = member.userId === myUserId;
  const isAdmin = myRole ? roleAtLeast(myRole, 'admin') : false;
  const isOwner = myRole === 'owner';
  // Admins can change everyone except owners; owners can change anyone.
  const canChangeRole =
    isAdmin && !isSelf && (member.role !== 'owner' || isOwner);
  // Admins can remove non-owners; owners can remove anyone but themselves (handled server-side).
  const canRemove =
    isAdmin && !isSelf && (member.role !== 'owner' || isOwner);

  return (
    <tr className="border-b border-sand/50 last:border-0">
      <td className="py-2">
        <div className="text-dark-brown font-medium">
          {member.displayName || member.email}
          {isSelf && <span className="text-warm-gray text-xs ml-1">(you)</span>}
        </div>
        <div className="text-xs text-warm-gray">{member.email}</div>
      </td>
      <td className="py-2">
        {canChangeRole ? (
          <select
            value={member.role}
            onChange={(e) => onChangeRole(e.target.value as OrgRole)}
            className="text-xs px-2 py-1 rounded border border-sand bg-white"
          >
            {isOwner && <option value="owner">Owner</option>}
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        ) : (
          <RoleBadge role={member.role} />
        )}
      </td>
      <td className="py-2 text-warm-gray">{formatDate(member.createdAt)}</td>
      <td className="py-2 text-right">
        {isSelf && member.role !== 'owner' && (
          <button
            onClick={onLeave}
            className="text-xs text-red-600 hover:text-red-700 hover:underline"
          >
            Leave
          </button>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            className="text-xs text-red-600 hover:text-red-700 hover:underline"
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function EditOrgDialog({
  initialName,
  initialSlug,
  onCancel,
  onSave,
}: {
  initialName: string;
  initialSlug: string;
  onCancel: () => void;
  onSave: (name: string, slug: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(name.trim(), slug.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">
          Edit organization
        </h3>
        <FormField label="Name" value={name} onChange={setName} required />
        <FormField label="Slug" value={slug} onChange={setSlug} required />
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" disabled={busy || !name.trim() || !slug.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function InviteDialog({
  canInviteAdmin,
  onClose,
  onInvite,
}: {
  canInviteAdmin: boolean;
  onClose: () => void;
  onInvite: (email: string, role: InviteRole) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onInvite(email.trim(), role);
      setSent(true);
      setEmail('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send invitation';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Invite member</h3>
        <FormField
          label="Email"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            setSent(false);
          }}
          required
        />
        <div className="mb-3">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as InviteRole)}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm text-dark-brown bg-cream focus:outline-none focus:border-coral focus:bg-white"
          >
            {canInviteAdmin && <option value="admin">Admin</option>}
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
        {sent && (
          <div className="mb-3 px-3 py-2 rounded-md bg-teal-light text-teal text-sm">
            Invitation sent.
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose}>
            Close
          </AuthButton>
          <AuthButton type="submit" disabled={busy || !email.trim()}>
            {busy ? 'Sending…' : 'Send invite'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function TransferDialog({
  members,
  onCancel,
  onConfirm,
}: {
  members: OrgMember[];
  onCancel: () => void;
  onConfirm: (userId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(members[0]?.userId ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await onConfirm(selected);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">
          Transfer ownership
        </h3>
        <p className="text-sm text-warm-gray mb-3">
          The selected member will become owner. You'll be demoted to admin.
        </p>
        <div className="mb-3">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            New owner
          </label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm text-dark-brown bg-cream focus:outline-none focus:border-coral focus:bg-white"
          >
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName || m.email} ({m.email})
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-dark-brown mb-4">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I understand this action can't be undone without the new owner's help.
        </label>
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </AuthButton>
          <AuthButton
            type="submit"
            variant="danger"
            disabled={busy || !selected || !confirmed}
          >
            {busy ? 'Transferring…' : 'Transfer ownership'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function DeleteOrgDialog({
  slug,
  onCancel,
  onConfirm,
}: {
  slug: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typed !== slug) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-red-700 mb-2">
          Delete organization
        </h3>
        <p className="text-sm text-warm-gray mb-3">
          This deletes the organization and its feeds. To confirm, type the slug{' '}
          <code className="font-mono text-dark-brown">{slug}</code> below.
        </p>
        <FormField
          label="Slug"
          value={typed}
          onChange={setTyped}
          placeholder={slug}
          required
        />
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" variant="danger" disabled={busy || typed !== slug}>
            {busy ? 'Deleting…' : 'Delete organization'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-sm mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">{title}</h3>
        <p className="text-sm text-warm-gray mb-5">{body}</p>
        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={onCancel}>
            Cancel
          </AuthButton>
          <AuthButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

function BrandingSection({
  org,
  canEdit,
  onUpdated,
}: {
  org: OrgInfo;
  canEdit: boolean;
  onUpdated: (org: OrgInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logoUrl = orgLogoUrl(org.id, org.brandLogoUpdatedAt);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const res = await uploadOrgLogo(org.id, file);
      onUpdated(res.organization);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await deleteOrgLogo(org.id);
      onUpdated(res.organization);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white border border-sand rounded-2xl p-6 mb-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-heading font-bold text-lg text-dark-brown">Branding</h2>
      </div>
      <p className="text-sm text-warm-gray mb-4">
        Upload a logo to display on your org's published feed pages (the landing page,
        per-route widgets, per-stop widgets). PNG, JPEG, WebP, or SVG. Max 1 MB.
      </p>
      <div className="flex items-center gap-4">
        <div className="w-32 h-16 border border-sand rounded-md bg-cream grid place-items-center overflow-hidden">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt="Current logo"
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <span className="text-xs text-warm-gray">No logo</span>
          )}
        </div>
        {canEdit ? (
          <div className="flex flex-col gap-2">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <span className="px-3 py-1.5 rounded-lg bg-coral text-white font-heading font-bold text-xs hover:bg-[#d4603a] transition-colors disabled:opacity-50">
                {busy ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                disabled={busy}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = ''; // allow re-uploading the same file later
                  handleFile(f);
                }}
              />
            </label>
            {logoUrl && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy}
                className="text-xs text-warm-gray hover:text-red-600 underline self-start disabled:opacity-50"
              >
                Remove logo
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-warm-gray italic">Admins or owners can change the logo.</p>
        )}
      </div>
      {error && (
        <div className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
    </section>
  );
}
