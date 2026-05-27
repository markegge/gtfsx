import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { Badge } from '../ui/Badge';
import { AppBrand } from '../layout/AppBrand';
import { UserMenu } from '../layout/UserMenu';
import {
  createProject,
  deleteProject,
  listProjects,
  patchProject,
  saveWorkingState,
  transferProject,
  type ProjectSummary,
  type TransferResult,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { roleAtLeast } from '../../services/orgsApi';
import { ImportDialog } from '../import-export/ImportDialog';
import { buildSnapshot, resetStoreEntities, setCurrentWorkingStateVersion, wipeLocalProject } from '../../db/serverPersistence';

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MyFeedsPage() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const feedsQuotaWarning = useStore((s) => s.feedsQuotaWarning);
  const setFeedsProjects = useStore((s) => s.setFeedsProjects);
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const removeFeedProject = useStore((s) => s.removeFeedProject);
  const setProjectId = useStore((s) => s.setProjectId);
  const setProjectName = useStore((s) => s.setProjectName);
  const setActiveServerProject = useStore((s) => s.setActiveServerProject);
  const markSaved = useStore((s) => s.markSaved);

  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<ProjectSummary | null>(null);
  const [moveResult, setMoveResult] = useState<{ message: string } | null>(null);

  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const userOrgs = useStore((s) => s.userOrgs);
  const scope =
    activeWorkspace.type === 'org' ? `org:${activeWorkspace.orgId}` : 'personal';
  const workspaceLabel =
    activeWorkspace.type === 'org'
      ? userOrgs.find((o) => o.id === activeWorkspace.orgId)?.name ?? 'Organization'
      : 'My personal feeds';

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await listProjects({ includeArchived, scope });
      setFeedsProjects(res.projects, res.quota.warning);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load feeds';
      setListError(msg);
    } finally {
      setLoading(false);
    }
  }, [includeArchived, scope, setFeedsProjects]);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) return;
    fetchList();
  }, [authChecked, currentUser, fetchList]);

  // After ImportDialog loads the feed into the editor store, persist it as a
  // new project owned by the active workspace (mirrors SaveAsDialog), then
  // open it in the editor. ImportDialog surfaces errors inline and stays open
  // on failure, so we let exceptions propagate.
  const handleImportComplete = async () => {
    const owner: { type: 'user' } | { type: 'org'; id: string } =
      activeWorkspace.type === 'org'
        ? { type: 'org', id: activeWorkspace.orgId }
        : { type: 'user' };
    const name = useStore.getState().projectName?.trim() || 'Imported Feed';
    const project = await createProject({ name, owner });
    setProjectId(project.id);
    setProjectName(project.name);
    const snapshot = buildSnapshot();
    const { workingStateVersion } = await saveWorkingState(project.id, snapshot, 0);
    setCurrentWorkingStateVersion(project.id, workingStateVersion);
    setActiveServerProject(project.id);
    upsertFeedProject({ ...project, workingStateVersion });
    markSaved();
    navigate(`/feeds/${encodeURIComponent(project.slug)}`);
  };

  if (!authChecked) {
    return (
      <AuthLayout title="My Feeds">
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!currentUser) {
    navigate(`/login?next=${encodeURIComponent('/feeds')}`, { replace: true });
    return null;
  }

  return (
    <div className="min-h-full bg-cream">
      <header className="h-14 bg-white border-b border-sand flex items-center px-3 sm:px-5 gap-2 sm:gap-3 shrink-0">
        <AppBrand mode="link" showTagline={false} />
        <div className="flex-1" />
        <UserMenu />
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="font-heading font-extrabold text-3xl text-dark-brown">
              {workspaceLabel}
            </h1>
            <p className="text-sm text-warm-gray mt-1">
              {activeWorkspace.type === 'org'
                ? 'Feeds owned by this organization. Switch workspace via the account menu.'
                : 'Feeds saved to your account. They sync across devices.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <AuthButton variant="secondary" onClick={() => setShowImport(true)}>
              Import feed
            </AuthButton>
            <AuthButton onClick={() => setShowCreate(true)}>+ Create feed</AuthButton>
          </div>
        </div>

        {feedsQuotaWarning && (() => {
          const activeOrg = activeWorkspace.type === 'org'
            ? userOrgs.find((o) => o.id === activeWorkspace.orgId)
            : null;
          const billingHref = activeOrg ? `/orgs/${activeOrg.slug}/billing` : '/pricing';
          const ownerPlan = activeOrg ? activeOrg.plan : currentUser?.plan;
          return (
            <div className="mb-5 px-4 py-3 rounded-lg bg-gold-light text-amber-700 text-sm border border-amber-200 flex items-center justify-between gap-3">
              <span>
                Feeds used: <strong>{feedsQuotaWarning}</strong>.
                {ownerPlan === 'free'
                  ? ' Free workspaces include up to 3 feeds — upgrade to keep saving more.'
                  : ' Archive or delete feeds to free space, or upgrade for higher limits.'}
              </span>
              <a
                href={billingHref}
                className="shrink-0 rounded-md bg-coral px-3 py-1.5 font-heading text-xs font-bold text-white hover:bg-[#d4603a]"
              >
                {ownerPlan === 'free' ? 'Upgrade' : 'Manage plan'}
              </a>
            </div>
          );
        })()}

        <div className="flex items-center gap-4 mb-4 text-sm">
          <label className="flex items-center gap-2 cursor-pointer text-warm-gray">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>

        {listError && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {listError}
          </div>
        )}

        {loading ? (
          <div className="text-warm-gray text-sm">Loading…</div>
        ) : feedsProjects.length === 0 ? (
          <div className="bg-white border border-sand rounded-2xl p-10 text-center">
            <div className="font-heading font-bold text-lg text-dark-brown mb-1">No feeds yet</div>
            <p className="text-warm-gray text-sm mb-4">Create a feed, or import an existing GTFS feed to get started.</p>
            <div className="flex items-center justify-center gap-2">
              <AuthButton variant="secondary" onClick={() => setShowImport(true)}>
                Import feed
              </AuthButton>
              <AuthButton onClick={() => setShowCreate(true)}>+ Create feed</AuthButton>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {feedsProjects.map((p) => (
              <FeedCard
                key={p.id}
                project={p}
                onOpen={() => navigate(`/feeds/${encodeURIComponent(p.slug)}`)}
                onRename={() => setRenameTarget(p)}
                onMove={() => setMoveTarget(p)}
                onArchiveToggle={async () => {
                  try {
                    const updated = await patchProject(p.id, {
                      archivedAt: p.archivedAt ? null : 'now',
                    });
                    upsertFeedProject(updated);
                    if (!includeArchived && updated.archivedAt) removeFeedProject(p.id);
                  } catch (err) {
                    const msg = err instanceof ApiError ? err.message : 'Update failed';
                    alert(msg);
                  }
                }}
                onDelete={() => setDeleteTarget(p)}
              />
            ))}
          </div>
        )}
      </main>

      {showCreate && (
        <CreateFeedDialog
          onClose={() => setShowCreate(false)}
          onCreated={async (p) => {
            upsertFeedProject(p);
            setShowCreate(false);
            // The previous project's routes/stops/calendars are still in the
            // in-memory store and in IndexedDB. Without a wipe, the new
            // editor would briefly render that stale data before the empty
            // server snapshot loads — and an autosave could even persist
            // the old data under the new project's id. Clear both.
            resetStoreEntities();
            await wipeLocalProject(p.id);
            navigate(`/feeds/${encodeURIComponent(p.slug)}`);
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onComplete={handleImportComplete}
          completeLabel={`Save to ${workspaceLabel}`}
        />
      )}

      {renameTarget && (
        <RenameFeedDialog
          project={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={(p) => {
            upsertFeedProject(p);
            setRenameTarget(null);
          }}
        />
      )}

      {moveTarget && (
        <MoveFeedDialog
          project={moveTarget}
          onClose={() => setMoveTarget(null)}
          onMoved={(result) => {
            // The project leaves the current workspace; drop it from the list.
            removeFeedProject(moveTarget.id);
            setMoveTarget(null);
            const dest =
              result.project.ownerType === 'user'
                ? 'your personal feeds'
                : userOrgs.find((o) => o.id === result.project.ownerId)?.name ?? 'organization';
            const slugNote = result.slugChanged
              ? ` Slug changed from "${result.previousSlug}" to "${result.project.slug}" to avoid a collision in the destination.`
              : '';
            setMoveResult({
              message: `"${result.project.name}" was moved to ${dest}.${slugNote}`,
            });
            setTimeout(() => setMoveResult(null), 8000);
          }}
        />
      )}

      {moveResult && (
        <div className="fixed bottom-6 right-6 max-w-md bg-teal text-white px-4 py-3 rounded-xl shadow-lg z-50 text-sm">
          {moveResult.message}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete feed?"
          body={`"${deleteTarget.name}" will be removed. This action can't be undone from here.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            try {
              await deleteProject(id);
              removeFeedProject(id);
              // Drop the locally-cached working state too, so a future
              // reload / autosave can't resurrect the deleted feed.
              await wipeLocalProject(id);
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Delete failed';
              alert(msg);
            }
          }}
        />
      )}
    </div>
  );
}

function FeedCard({
  project,
  onOpen,
  onRename,
  onMove,
  onArchiveToggle,
  onDelete,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}) {
  const archived = !!project.archivedAt;
  const lastEdited = project.workingStateUpdatedAt ?? project.updatedAt;

  return (
    <div
      className={`bg-white border rounded-2xl p-4 flex items-center gap-4 transition-colors ${
        archived ? 'border-sand opacity-70' : 'border-sand hover:border-coral/40'
      }`}
    >
      <button
        onClick={onOpen}
        className="flex-1 text-left focus:outline-none"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="font-heading font-bold text-base text-dark-brown">{project.name}</span>
          {archived && <Badge variant="warning">Archived</Badge>}
        </div>
        <div className="text-xs text-warm-gray">
          <span className="font-mono">{project.slug}</span>
          <span className="mx-2">·</span>
          Edited {formatDate(lastEdited)}
          <span className="mx-2">·</span>
          {project.snapshotCount ?? 0} snapshot{(project.snapshotCount ?? 0) === 1 ? '' : 's'}
        </div>
        {project.description && (
          <div className="text-sm text-warm-gray mt-1 line-clamp-2">{project.description}</div>
        )}
      </button>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className="w-8 h-8 rounded-md text-warm-gray hover:text-coral hover:bg-cream flex items-center justify-center"
            aria-label="Feed actions"
            title="Actions"
          >
            •••
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="bg-white rounded-xl shadow-lg border border-sand p-1 w-44 z-50"
          >
            <PopoverItem onSelect={onOpen}>Open</PopoverItem>
            <PopoverItem onSelect={onRename}>Rename</PopoverItem>
            <PopoverItem onSelect={onMove}>Move to…</PopoverItem>
            <PopoverItem onSelect={onArchiveToggle}>
              {archived ? 'Unarchive' : 'Archive'}
            </PopoverItem>
            <PopoverItem onSelect={onDelete} danger>
              Delete
            </PopoverItem>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function PopoverItem({
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
          danger
            ? 'text-red-600 hover:bg-red-50'
            : 'text-dark-brown hover:bg-cream'
        }`}
      >
        {children}
      </button>
    </Popover.Close>
  );
}

function CreateFeedDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: ProjectSummary) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeWorkspace = useStore((s) => s.activeWorkspace);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const owner: { type: 'user' } | { type: 'org'; id: string } =
        activeWorkspace.type === 'org'
          ? { type: 'org', id: activeWorkspace.orgId }
          : { type: 'user' };
      const p = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        owner,
      });
      onCreated(p);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Create failed';
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
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Create feed</h3>
        <FormField label="Name" value={name} onChange={setName} required />
        <FormField
          label="Description (optional)"
          value={description}
          onChange={setDescription}
        />
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function RenameFeedDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onSaved: (p: ProjectSummary) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [slug, setSlug] = useState(project.slug);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const updated = await patchProject(project.id, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        slug: slug.trim() !== project.slug ? slug.trim() : undefined,
      });
      onSaved(updated);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Update failed';
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
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Edit feed</h3>
        <FormField label="Name" value={name} onChange={setName} required />
        <FormField label="Slug" value={slug} onChange={setSlug} required />
        <FormField label="Description" value={description} onChange={setDescription} />
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose}>
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

function MoveFeedDialog({
  project,
  onClose,
  onMoved,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onMoved: (result: TransferResult) => void;
}) {
  const userOrgs = useStore((s) => s.userOrgs);
  // Destination options: personal (if not already there) + every org I'm
  // editor+ in (excluding the current owner).
  const options = useMemo(() => {
    const opts: { value: string; label: string; type: 'user' | 'org'; orgId?: string }[] = [];
    if (project.ownerType !== 'user') {
      opts.push({ value: 'user', label: 'My personal feeds', type: 'user' });
    }
    for (const org of userOrgs) {
      if (project.ownerType === 'org' && project.ownerId === org.id) continue;
      if (!roleAtLeast(org.role, 'editor')) continue;
      opts.push({ value: `org:${org.id}`, label: org.name, type: 'org', orgId: org.id });
    }
    return opts;
  }, [userOrgs, project]);

  const [value, setValue] = useState<string>(options[0]?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setError(null);
    setBusy(true);
    try {
      const opt = options.find((o) => o.value === value);
      if (!opt) throw new Error('Pick a destination');
      const destination =
        opt.type === 'user'
          ? ({ type: 'user' } as const)
          : ({ type: 'org', id: opt.orgId! } as const);
      const result = await transferProject(project.id, destination);
      onMoved(result);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Move failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : onClose} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">Move feed</h3>
        <p className="text-xs text-warm-gray mb-4">
          Move <span className="font-semibold text-dark-brown">{project.name}</span> to a different
          workspace. Snapshots, working state, and any active publication move with it.
        </p>
        {options.length === 0 ? (
          <div className="px-3 py-2 mb-3 rounded-md bg-cream text-sm text-warm-gray">
            No destinations available. Create an organization or join one as an editor to enable
            this.
          </div>
        ) : (
          <>
            <label className="block text-xs font-semibold text-dark-brown mb-1">Destination</label>
            <select
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              className="w-full mb-4 px-3 py-2 rounded-lg border border-sand focus:border-coral focus:outline-none text-sm bg-white"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-warm-gray mb-3">
              If the slug <span className="font-mono">{project.slug}</span> is already in use in the
              destination, a number will be appended.
            </p>
          </>
        )}
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" disabled={busy || options.length === 0 || !value}>
            {busy ? 'Moving…' : 'Move'}
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
