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
  duplicateProject,
  listDeletedProjects,
  listProjects,
  patchProject,
  restoreProject,
  saveWorkingState,
  setProjectLocked,
  transferProject,
  type DeletedProjectSummary,
  type ProjectSummary,
  type TransferResult,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { fireProNudge } from '../../services/proIntent';
import { roleAtLeast } from '../../services/orgsApi';
import { ImportDialog } from '../import-export/ImportDialog';
import { buildSnapshot, resetStoreEntities, setCurrentWorkingStateVersion, wipeLocalProject } from '../../db/serverPersistence';
import { generateId } from '../../services/idGenerator';
import {
  formatPurgeCountdown,
  publishedDeleteMessage,
  requiresUnpublishBeforeDelete,
  restoreSlugChangeMessage,
} from '../../services/feedDeletion';

// Free plan saves 3 feeds (server PLAN_QUOTAS.free.projects). Creating a 4th is
// allowed in prod (the cap is soft, HARD_LIMITS=false) but is the moment to sell
// Planner. Mirrors the "Free saves 3 feeds" copy.
const FREE_FEED_CAP = 3;

// Env-aware public feeds origin (mirrors PublishPanel/EmbedPanel): staging
// publishes to staging-feeds.gtfsx.com, prod to feeds.gtfsx.com. Used to build
// the "this feed is live at <url>" copy on the published-delete dialog.
const FEEDS_ORIGIN =
  (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
  (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
    ? 'https://staging-feeds.gtfsx.com'
    : 'https://feeds.gtfsx.com');

// Delete flow state machine (issue #63): a plain confirm for an unpublished
// feed, or a distinct published-feed dialog offering "unpublish and delete"
// instead. The 'published' mode is also entered defensively if a plain delete
// comes back 409 (e.g. the feed got published from another tab mid-flow).
type DeleteFlow =
  | { mode: 'confirm'; project: ProjectSummary }
  | { mode: 'published'; project: ProjectSummary; message: string; busy: boolean; error: string | null };

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
  const setProNudgeToast = useStore((s) => s.setProNudgeToast);
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

  const [deleteFlow, setDeleteFlow] = useState<DeleteFlow | null>(null);
  // Undo affordance for a just-completed delete (mirrors ValidationPanel's
  // fix-undo toast: a message + an explicit Undo action + a manual dismiss, no
  // auto-hide timer — the delete is a soft delete, so Undo just restores it).
  const [deleteUndo, setDeleteUndo] = useState<{ project: ProjectSummary; message: string } | null>(null);
  // The caller's soft-deleted feeds for the Recently-deleted section. null =
  // not loaded yet (render nothing rather than an empty/loading trash section).
  const [deletedProjects, setDeletedProjects] = useState<DeletedProjectSummary[] | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<ProjectSummary | null>(null);
  // General-purpose bottom-right info notice (auto-dismisses); used by both
  // the move-feed slug-collision message and the restore-changed-slug message.
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const showNotice = useCallback((message: string) => {
    setNotice({ message });
    setTimeout(() => setNotice(null), 8000);
  }, []);

  // Locked feeds pin to the top of the list (issue #36). The server already
  // sorts by last-edited; this is a stable partition that preserves that order
  // within the locked and unlocked groups.
  const sortedProjects = useMemo(() => {
    return [...feedsProjects].sort((a, b) => Number(b.locked) - Number(a.locked));
  }, [feedsProjects]);

  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const userOrgs = useStore((s) => s.userOrgs);
  const scope =
    activeWorkspace.type === 'org' ? `org:${activeWorkspace.orgId}` : 'personal';
  const workspaceLabel =
    activeWorkspace.type === 'org'
      ? userOrgs.find((o) => o.id === activeWorkspace.orgId)?.name ?? 'Organization'
      : 'My personal feeds';
  // Creating/duplicating a feed in an org needs editor+ (the server enforces
  // this too). Personal feeds are always editable by their owner.
  const canEdit =
    activeWorkspace.type === 'org' ? roleAtLeast(activeWorkspace.role, 'editor') : true;

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

  // Recently-deleted list (issue #63) — scoped like the main list so an org's
  // trash isn't mixed with the caller's personal one. This is a secondary,
  // below-the-fold feature: a failure here just leaves the section unrendered
  // rather than surfacing an error banner over the primary feeds list.
  const fetchDeletedList = useCallback(async () => {
    try {
      const res = await listDeletedProjects({ scope });
      setDeletedProjects(res.projects);
    } catch {
      setDeletedProjects((prev) => prev ?? []);
    }
  }, [scope]);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) return;
    fetchList();
    fetchDeletedList();
  }, [authChecked, currentUser, fetchList, fetchDeletedList]);

  // Shared by the delete-undo toast and the Recently-deleted row's Restore
  // button — both just call POST .../restore and reconcile local state.
  // Surfaces a notice when the server assigned a different slug (the old one
  // was claimed by another feed while this one sat in the trash).
  const restoreProjectById = useCallback(
    async (id: string, previousSlug: string) => {
      const restored = await restoreProject(id);
      upsertFeedProject(restored);
      setDeletedProjects((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
      const slugNote = restoreSlugChangeMessage(previousSlug, restored);
      if (slugNote) showNotice(slugNote);
      return restored;
    },
    [upsertFeedProject, showNotice],
  );

  const handleUndoDelete = async () => {
    if (!deleteUndo) return;
    const { project } = deleteUndo;
    setDeleteUndo(null);
    try {
      await restoreProjectById(project.id, project.slug);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Restore failed';
      alert(msg);
    }
  };

  const handleRestoreFromTrash = async (project: DeletedProjectSummary) => {
    setRestoringId(project.id);
    try {
      await restoreProjectById(project.id, project.slug);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Restore failed';
      alert(msg);
    } finally {
      setRestoringId(null);
    }
  };

  // Performs the actual soft-delete request. On success, drops the feed from
  // the active list and offers Undo. On a published/locked 409, (re)opens the
  // published-delete dialog with the server's own message rather than
  // failing generically — this is also how a plain confirm-delete recovers if
  // the feed was published from another tab between load and click.
  const performDelete = useCallback(
    async (project: ProjectSummary, opts: { unpublish?: boolean } = {}) => {
      try {
        await deleteProject(project.id, opts);
        removeFeedProject(project.id);
        // Drop the locally-cached working state too, so a future reload /
        // autosave can't resurrect the deleted feed.
        await wipeLocalProject(project.id);
        setDeleteFlow(null);
        setDeleteUndo({ project, message: `"${project.name}" deleted.` });
        void fetchDeletedList();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setDeleteFlow({ mode: 'published', project, message: err.message, busy: false, error: null });
          return;
        }
        throw err;
      }
    },
    [removeFeedProject, fetchDeletedList],
  );

  // Feed-cap nudge (nudge "b"): a free owner who is OVER the saved-feed cap gets
  // a one-time, dismissible upgrade toast + the recorded pro-intent signal.
  // fireProNudge gates to logged-in free owners and dedupes per trigger, so this
  // is a no-op for paid workspaces and after the first fire. The cap is soft in
  // prod (HARD_LIMITS=false), so this is the only thing that sells at the cap.
  const fireFeedCapNudge = useCallback(
    (source: string): boolean => {
      const activeOrg =
        activeWorkspace.type === 'org'
          ? userOrgs.find((o) => o.id === activeWorkspace.orgId)
          : null;
      const ownerPlan = activeOrg ? activeOrg.plan : currentUser?.plan;
      const fired = fireProNudge({
        loggedIn: !!currentUser,
        plan: ownerPlan,
        action: 'feed_cap',
        source,
      });
      if (fired) setProNudgeToast({ action: 'feed_cap' });
      return fired;
    },
    [activeWorkspace, userOrgs, currentUser, setProNudgeToast],
  );

  // Visiting the feeds list while over the cap (e.g. returning later) is a valid
  // moment to nudge too — `used/limit` from the server, strictly over.
  useEffect(() => {
    if (!feedsQuotaWarning) return;
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(feedsQuotaWarning.trim());
    if (!m) return;
    if (Number(m[1]) <= Number(m[2])) return; // only OVER the cap (4th+ feed)
    fireFeedCapNudge('feeds_quota_banner');
  }, [feedsQuotaWarning, fireFeedCapNudge]);

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
                  ? ' Free saves 3 feeds. Planner saves unlimited and hosts them.'
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
            {sortedProjects.map((p) => (
              <FeedCard
                key={p.id}
                project={p}
                canEdit={canEdit}
                onOpen={() => navigate(`/feeds/${encodeURIComponent(p.slug)}`)}
                onRename={() => setRenameTarget(p)}
                onMove={() => setMoveTarget(p)}
                onDuplicate={async () => {
                  try {
                    const copy = await duplicateProject(p.id);
                    // Refresh the list so the new copy appears in the
                    // server's canonical order (and picks up snapshot/quota
                    // metadata). Optimistically insert first so it shows even
                    // if the refetch is slow.
                    upsertFeedProject(copy);
                    await fetchList();
                  } catch (err) {
                    const msg = err instanceof ApiError ? err.message : 'Duplicate failed';
                    alert(msg);
                  }
                }}
                onLockToggle={async () => {
                  try {
                    const updated = await setProjectLocked(p.id, !p.locked);
                    upsertFeedProject(updated);
                  } catch (err) {
                    const msg = err instanceof ApiError ? err.message : 'Update failed';
                    alert(msg);
                  }
                }}
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
                onDelete={() =>
                  setDeleteFlow(
                    requiresUnpublishBeforeDelete(p)
                      ? { mode: 'published', project: p, message: publishedDeleteMessage(p, FEEDS_ORIGIN), busy: false, error: null }
                      : { mode: 'confirm', project: p },
                  )
                }
              />
            ))}
          </div>
        )}

        {deletedProjects && (
          <RecentlyDeletedSection
            projects={deletedProjects}
            restoringId={restoringId}
            onRestore={handleRestoreFromTrash}
          />
        )}
      </main>

      {showCreate && (
        <CreateFeedDialog
          onClose={() => setShowCreate(false)}
          onCreated={async (p) => {
            upsertFeedProject(p);
            setShowCreate(false);
            // Feed-cap nudge at the moment of value: this create takes a free
            // user OVER the free cap (the soft prod path succeeds silently, so
            // nothing else sells here). +1 because feedsProjects hasn't
            // re-rendered with the new feed yet. fireFeedCapNudge gates to free
            // owners + dedupes; the toast shows in the editor we navigate to.
            if (feedsProjects.length + 1 > FREE_FEED_CAP) {
              fireFeedCapNudge('create_over_cap');
            }
            // The previous project's routes/stops/calendars are still in the
            // in-memory store and in IndexedDB. Without a wipe, the new
            // editor would briefly render that stale data before the empty
            // server snapshot loads — and an autosave could even persist
            // the old data under the new project's id. Clear both.
            resetStoreEntities();
            await wipeLocalProject(p.id);

            // Org-owned feeds: pre-seed an agency stamped with the org's name.
            // Every GTFS feed needs an agency, and the org name is almost
            // always the right agency_name for the agency creating it. Saves
            // the user a step on the very first edit. Personal-workspace
            // creates skip this (no obvious name to seed with).
            if (activeWorkspace.type === 'org') {
              const org = userOrgs.find((o) => o.id === activeWorkspace.orgId);
              if (org) {
                useStore.getState().addAgency({
                  agency_id: generateId('agency'),
                  agency_name: org.name,
                  agency_url: '',
                  // Default zone matches AgencyEditor's handleAdd — the user
                  // changes it in the agency form if needed.
                  agency_timezone: 'America/Denver',
                });
                // Persist the seeded agency to the server BEFORE navigating
                // so the editor mount's loadProjectFromServer fetches a
                // snapshot that includes it. Otherwise applySnapshotToStore
                // would reset entities (per the recent leak fix) and the
                // agency would only re-appear on the next reload.
                try {
                  const snapshot = buildSnapshot();
                  const { workingStateVersion } = await saveWorkingState(p.id, snapshot, 0);
                  setCurrentWorkingStateVersion(p.id, workingStateVersion);
                  upsertFeedProject({ ...p, workingStateVersion });
                  markSaved();
                } catch {
                  // If the seed save fails (offline, conflict, etc.) the
                  // editor still loads — just with no agency, same as the
                  // pre-feature behaviour. Don't block navigation on this.
                }
              }
            }
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
            showNotice(`"${result.project.name}" was moved to ${dest}.${slugNote}`);
          }}
        />
      )}

      {notice && (
        <div className="fixed bottom-6 right-6 max-w-md bg-teal text-white px-4 py-3 rounded-xl shadow-lg z-50 text-sm">
          {notice.message}
        </div>
      )}

      {deleteFlow?.mode === 'confirm' && (
        <ConfirmDialog
          title="Delete feed?"
          body={`"${deleteFlow.project.name}" will be removed. This action can't be undone from here.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteFlow(null)}
          onConfirm={async () => {
            try {
              await performDelete(deleteFlow.project);
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Delete failed';
              alert(msg);
              setDeleteFlow(null);
            }
          }}
        />
      )}

      {deleteFlow?.mode === 'published' && (
        <PublishedDeleteDialog
          project={deleteFlow.project}
          message={deleteFlow.message}
          error={deleteFlow.error}
          busy={deleteFlow.busy}
          onCancel={() => setDeleteFlow(null)}
          onUnpublishAndDelete={async () => {
            setDeleteFlow((f) => (f && f.mode === 'published' ? { ...f, busy: true, error: null } : f));
            try {
              await performDelete(deleteFlow.project, { unpublish: true });
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Delete failed';
              setDeleteFlow((f) => (f && f.mode === 'published' ? { ...f, busy: false, error: msg } : f));
            }
          }}
        />
      )}

      {deleteUndo && (
        // Offset above the `notice` position (bottom-6) so the two can't overlap
        // if a move-notice happens to be showing at the same time.
        <div className="fixed bottom-24 right-6 max-w-md flex items-center gap-2 bg-teal-light border border-teal/30 rounded-xl px-4 py-3 shadow-lg z-50 text-sm text-dark-brown">
          <span className="flex-1">{deleteUndo.message}</span>
          <button onClick={handleUndoDelete} className="text-coral font-semibold hover:underline shrink-0">
            Undo
          </button>
          <button
            onClick={() => setDeleteUndo(null)}
            className="text-warm-gray hover:text-dark-brown shrink-0"
            title="Dismiss"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function FeedCard({
  project,
  canEdit,
  onOpen,
  onRename,
  onMove,
  onDuplicate,
  onLockToggle,
  onArchiveToggle,
  onDelete,
}: {
  project: ProjectSummary;
  canEdit: boolean;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onDuplicate: () => Promise<void>;
  onLockToggle: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}) {
  const archived = !!project.archivedAt;
  const locked = project.locked;
  const lastEdited = project.workingStateUpdatedAt ?? project.updatedAt;
  const [duplicating, setDuplicating] = useState(false);

  return (
    <div
      className={`bg-white border rounded-2xl p-4 flex items-center gap-4 transition-colors ${
        archived ? 'border-sand opacity-70' : 'border-sand hover:border-coral/40'
      }`}
    >
      {project.thumbnailUrl && (
        <img
          src={project.thumbnailUrl}
          alt=""
          loading="lazy"
          className="hidden sm:block w-28 h-20 object-cover rounded-lg border border-sand bg-cream shrink-0"
          onError={(e) => {
            // No thumbnail available — hide gracefully rather than show a broken image.
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
      <button
        onClick={onOpen}
        className="flex-1 text-left focus:outline-none"
      >
        <div className="flex items-center gap-2 mb-1">
          {locked && (
            <span title="Locked — protected from edits and deletion" aria-label="Locked">
              🔒
            </span>
          )}
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
            <PopoverItem
              onSelect={onRename}
              disabled={locked}
              title={locked ? 'Unlock the feed to rename it' : undefined}
            >
              Rename
            </PopoverItem>
            <PopoverItem onSelect={onMove}>Move to…</PopoverItem>
            {canEdit && (
              <PopoverItem
                keepOpen
                onSelect={() => {
                  if (duplicating) return;
                  // Keep the menu open while the request is in flight so the
                  // busy label is visible; onDuplicate refreshes the list and
                  // surfaces any quota/permission error on success/failure.
                  setDuplicating(true);
                  void onDuplicate().finally(() => setDuplicating(false));
                }}
                disabled={duplicating}
                title={duplicating ? 'Duplicating…' : 'Make an independent copy of this feed'}
              >
                {duplicating ? 'Duplicating…' : 'Duplicate'}
              </PopoverItem>
            )}
            <PopoverItem onSelect={onLockToggle}>
              {locked ? 'Unlock' : 'Lock'}
            </PopoverItem>
            <PopoverItem onSelect={onArchiveToggle}>
              {archived ? 'Unarchive' : 'Archive'}
            </PopoverItem>
            <PopoverItem
              onSelect={onDelete}
              danger
              disabled={locked}
              title={locked ? 'Unlock the feed to delete it' : undefined}
            >
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
  disabled = false,
  keepOpen = false,
  title,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** When true, clicking does NOT close the popover (e.g. async busy actions). */
  keepOpen?: boolean;
  title?: string;
}) {
  const button = (
    <button
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      title={title}
      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? 'text-red-600 hover:bg-red-50 disabled:hover:bg-transparent'
          : 'text-dark-brown hover:bg-cream disabled:hover:bg-transparent'
      }`}
    >
      {children}
    </button>
  );
  // A disabled (or keepOpen) item keeps the menu open (no Popover.Close wrapper)
  // so the user sees the tooltip / busy state / can pick a different action.
  return disabled || keepOpen ? button : <Popover.Close asChild>{button}</Popover.Close>;
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
  const currentUser = useStore((s) => s.currentUser);
  const userOrgs = useStore((s) => s.userOrgs);

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
      // Hard-limit path (HARD_LIMITS=true): the server rejects the over-cap
      // create with a quota/payment error. Reword it to SELL (nudge "b") and
      // record the feed_cap signal. In prod the cap is soft, so this branch is
      // dormant and the banner on MyFeedsPage carries the nudge instead.
      const apiErr = err instanceof ApiError ? err : null;
      // The worker sends these codes (quotas.ts), but the client ApiErrorCode
      // union is narrower, so compare as a string. 402 = paymentRequired,
      // 409 = quotaExceeded for the projects quota.
      const code = apiErr?.code as string | undefined;
      const isQuota =
        !!apiErr &&
        (apiErr.status === 402 ||
          apiErr.status === 409 ||
          code === 'quota_exceeded' ||
          code === 'payment_required');
      if (isQuota) {
        const activeOrg =
          activeWorkspace.type === 'org'
            ? userOrgs.find((o) => o.id === activeWorkspace.orgId)
            : null;
        const ownerPlan = activeOrg ? activeOrg.plan : currentUser?.plan;
        fireProNudge({
          loggedIn: !!currentUser,
          plan: ownerPlan,
          action: 'feed_cap',
          source: 'create_feed_dialog',
        });
        setError('Free saves 3 feeds. Planner saves unlimited and hosts them.');
      } else {
        setError(apiErr ? apiErr.message : 'Create failed');
      }
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

// Shown instead of the plain ConfirmDialog when the feed being deleted is
// published (issue #63) — a live feed may have real transit apps and riders
// pulling from it, so deleting it isn't a plain "are you sure": it must be
// unpublished first. `message` is either the proactive copy (computed from
// the ProjectSummary the list already has) or, on the defensive 409 path (the
// feed got published from another tab mid-flow), the server's own message.
function PublishedDeleteDialog({
  project,
  message,
  error,
  busy,
  onCancel,
  onUnpublishAndDelete,
}: {
  project: ProjectSummary;
  message: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onUnpublishAndDelete: () => void;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={busy ? undefined : onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">
          {`"${project.name}" is published`}
        </h3>
        <p className="text-sm text-warm-gray mb-4">{message}</p>
        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          {/* The deliberate/danger action — not the default the user lands on. */}
          <AuthButton variant="danger" onClick={onUnpublishAndDelete} disabled={busy}>
            {busy ? 'Unpublishing and deleting…' : 'Unpublish and delete'}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

// Secondary, collapsed-by-default trash view (issue #63). Mirrors
// ValidationPanel's "N dismissed" disclosure: a small muted toggle that
// expands into a restorable list, kept out of the way of the primary feeds
// grid above it. Renders nothing when there's nothing deleted.
function RecentlyDeletedSection({
  projects,
  restoringId,
  onRestore,
}: {
  projects: DeletedProjectSummary[];
  restoringId: string | null;
  onRestore: (project: DeletedProjectSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;
  return (
    <div className="mt-6 border-t border-sand pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-warm-gray hover:text-dark-brown flex items-center gap-1.5"
        aria-expanded={open}
      >
        <span className="inline-block w-3">{open ? '▾' : '▸'}</span>
        Recently deleted ({projects.length})
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 bg-white/60 border border-sand rounded-lg px-3 py-2 text-xs text-warm-gray"
            >
              <div className="min-w-0">
                <div className="text-dark-brown font-medium truncate">{p.name}</div>
                <div>
                  Deleted {formatDate(p.deletedAt)} ({formatPurgeCountdown(p.purgeAt)})
                </div>
              </div>
              <button
                onClick={() => onRestore(p)}
                disabled={restoringId === p.id}
                className="shrink-0 text-coral hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
              >
                {restoringId === p.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
