import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { ImportDialog } from '../import-export/ImportDialog';
import { ExportDialog } from '../import-export/ExportDialog';
import { HelpDialog } from '../help/HelpDialog';
import { SaveAsDialog } from '../feeds/SaveAsDialog';
import { db } from '../../db/dexie';
import { logout as apiLogout, ApiError } from '../../services/authApi';
import { createOrg, type OrgRole } from '../../services/orgsApi';
import { patchProject } from '../../services/projectsApi';
import { saveProjectNow } from '../../db/serverPersistence';
import { backendEnabled } from '../../utils/featureFlags';

const ROLE_COLORS: Record<OrgRole, string> = {
  owner: 'bg-coral/15 text-coral border-coral/30',
  admin: 'bg-gold/15 text-[#9c7100] border-gold/30',
  editor: 'bg-teal-light text-teal border-teal/30',
  viewer: 'bg-sand text-warm-gray border-sand',
};

export function RoleBadge({ role }: { role: OrgRole }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${ROLE_COLORS[role]}`}>
      {role}
    </span>
  );
}

export function TopBar() {
  const { projectName, setProjectName, lastSavedAt, isDirty } = useStore();
  const currentUser = useStore((s) => s.currentUser);
  const clearAuth = useStore((s) => s.clearAuth);
  const userOrgs = useStore((s) => s.userOrgs);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const upsertUserOrg = useStore((s) => s.upsertUserOrg);
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const navigate = useNavigate();
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleHomeClick = () => {
    // Check if there's any data worth warning about
    const state = useStore.getState();
    const hasData = state.routes.length > 0 || state.stops.length > 0 || state.shapes.length > 0;
    if (hasData) {
      setShowResetConfirm(true);
    } else {
      db.projectData.clear().then(() => db.projects.clear()).then(() => window.location.reload());
    }
  };

  const saveStatus = isDirty ? 'Unsaved changes' : lastSavedAt ? 'Saved' : 'New project';

  const handleSaveClick = async () => {
    if (!backendEnabled) return;
    setSaveError(null);
    if (!currentUser) {
      const next = `${window.location.pathname || '/'}?save=1`;
      navigate(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (!activeServerProjectId) {
      setShowSaveAs(true);
      return;
    }
    setSaving(true);
    try {
      await saveProjectNow(activeServerProjectId);
      // If the project name was edited via the pill, the change lives only
      // in-memory until we PATCH the project metadata.
      const proj = feedsProjects.find((p) => p.id === activeServerProjectId);
      if (proj && proj.name !== projectName) {
        const updated = await patchProject(activeServerProjectId, { name: projectName });
        upsertFeedProject(updated);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Save failed';
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="h-14 bg-white border-b border-sand flex items-center px-5 gap-4 shrink-0">
        {/* Logo — home link */}
        <button
          onClick={handleHomeClick}
          className="flex items-center gap-2 font-heading font-extrabold text-xl text-coral hover:opacity-80 transition-opacity"
          title="Start new project"
        >
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#E8734A"/>
            <path d="M6 24 C10 24, 10 8, 16 8 S22 24, 26 24" stroke="#FFF8F0" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <circle cx="8" cy="22" r="2.5" fill="#FFF8F0"/>
            <circle cx="16" cy="8" r="2.5" fill="#FFF8F0"/>
            <circle cx="24" cy="22" r="2.5" fill="#FFF8F0"/>
            <rect x="12" y="14" width="8" height="5" rx="1.5" fill="#FFF8F0"/>
            <rect x="13.5" y="15" width="2" height="2" rx="0.5" fill="#E8734A"/>
            <rect x="16.5" y="15" width="2" height="2" rx="0.5" fill="#E8734A"/>
            <circle cx="14" cy="19.5" r="1" fill="#FFF8F0"/>
            <circle cx="18" cy="19.5" r="1" fill="#FFF8F0"/>
          </svg>
          GTFS Builder
        </button>

        {/* Tagline */}
        <span className="hidden lg:inline text-sm font-medium text-warm-gray border-l border-sand pl-4 -ml-1">
          The Free Online GTFS Feed Editor
        </span>

        {/* Project name */}
        {editing ? (
          <input
            autoFocus
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
            className="font-semibold text-dark-brown px-3 py-1 bg-white border-2 border-coral rounded-md text-sm outline-none"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="font-semibold text-dark-brown px-3 py-1 bg-sand rounded-md text-sm hover:bg-coral-light transition-colors"
          >
            {projectName}
          </button>
        )}

        {/* Save status */}
        <div className="flex items-center gap-1.5 text-xs text-warm-gray">
          <div className={`w-1.5 h-1.5 rounded-full ${isDirty ? 'bg-gold' : 'bg-teal'}`} />
          {saveStatus}
        </div>

        {/* Save button */}
        {backendEnabled && (
          <button
            onClick={handleSaveClick}
            disabled={saving || (!isDirty && !!activeServerProjectId)}
            className="px-3 py-1.5 rounded-lg font-heading font-bold text-xs bg-teal text-white hover:bg-[#0e7e75] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              !currentUser
                ? 'Sign in to save'
                : activeServerProjectId
                  ? 'Save changes'
                  : 'Save to your account'
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {saveError && (
          <span className="text-xs text-red-600 truncate max-w-[14rem]" title={saveError}>
            {saveError}
          </span>
        )}

        <div className="flex-1" />

        {/* Actions */}
        <button
          onClick={() => setShowHelp(true)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors text-sm font-bold"
          title="Help"
        >
          ?
        </button>
        <button
          onClick={() => setShowImport(true)}
          className="px-4 py-2 rounded-lg font-heading font-bold text-sm bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors"
        >
          Import
        </button>
        <button
          onClick={() => setShowExport(true)}
          className="px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors"
        >
          Export GTFS
        </button>

        {backendEnabled && currentUser ? (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                className="w-9 h-9 rounded-full bg-coral text-white font-heading font-bold text-sm flex items-center justify-center hover:bg-[#d4603a] transition-colors"
                title={currentUser.email}
                aria-label="Account menu"
              >
                {initialsFromName(currentUser.displayName || currentUser.email)}
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={8}
                className="bg-white rounded-xl shadow-lg border border-sand p-2 w-64 z-50"
              >
                <div className="px-3 py-2 border-b border-sand mb-1">
                  <div className="text-sm font-semibold text-dark-brown truncate">
                    {currentUser.displayName}
                  </div>
                  <div className="text-xs text-warm-gray truncate">{currentUser.email}</div>
                </div>

                {/* Workspace switcher */}
                <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                  Workspace
                </div>
                <button
                  onClick={() => {
                    setActiveWorkspace({ type: 'personal' });
                    navigate('/feeds');
                  }}
                  className={`w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${
                    activeWorkspace.type === 'personal' ? 'bg-cream text-dark-brown font-semibold' : 'text-dark-brown hover:bg-cream'
                  }`}
                >
                  <span className="truncate">My personal feeds</span>
                  {activeWorkspace.type === 'personal' && <span className="text-coral text-xs">✓</span>}
                </button>
                {userOrgs.map((org) => {
                  const active = activeWorkspace.type === 'org' && activeWorkspace.orgId === org.id;
                  return (
                    <button
                      key={org.id}
                      onClick={() => {
                        setActiveWorkspace({ type: 'org', orgId: org.id, role: org.role });
                        navigate('/feeds');
                      }}
                      className={`w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${
                        active ? 'bg-cream text-dark-brown font-semibold' : 'text-dark-brown hover:bg-cream'
                      }`}
                    >
                      <span className="truncate flex-1">{org.name}</span>
                      <RoleBadge role={org.role} />
                    </button>
                  );
                })}
                <button
                  onClick={() => setShowCreateOrg(true)}
                  className="w-full text-left px-3 py-1.5 rounded-md text-sm text-coral hover:bg-cream transition-colors"
                >
                  + Create organization…
                </button>

                <div className="border-t border-sand my-1" />
                <button
                  onClick={() => navigate('/feeds')}
                  className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
                >
                  My Feeds
                </button>
                <button
                  onClick={() => navigate('/account')}
                  className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
                >
                  Account settings
                </button>
                {activeWorkspace.type === 'org' &&
                  (() => {
                    const activeOrg = userOrgs.find((o) => o.id === activeWorkspace.orgId);
                    if (!activeOrg) return null;
                    return (
                      <button
                        onClick={() => navigate(`/orgs/${encodeURIComponent(activeOrg.slug)}`)}
                        className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
                      >
                        Organization settings
                      </button>
                    );
                  })()}
                {currentUser.staff && (
                  <button
                    onClick={() => navigate('/admin')}
                    className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
                  >
                    Admin console
                  </button>
                )}
                <button
                  onClick={async () => {
                    try {
                      await apiLogout();
                    } catch {
                      // ignore — still clear local state
                    }
                    clearAuth();
                    navigate('/');
                  }}
                  className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
                >
                  Sign out
                </button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : backendEnabled ? (
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-2 rounded-lg font-heading font-bold text-sm bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors"
          >
            Sign in
          </button>
        ) : null}
      </div>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showSaveAs && <SaveAsDialog onClose={() => setShowSaveAs(false)} />}
      {showCreateOrg && (
        <CreateOrgDialog
          onClose={() => setShowCreateOrg(false)}
          onCreated={(org) => {
            upsertUserOrg(org);
            setActiveWorkspace({ type: 'org', orgId: org.id, role: org.role });
            setShowCreateOrg(false);
            navigate('/feeds');
          }}
        />
      )}

      {showResetConfirm && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="absolute inset-0 bg-black/20" onClick={() => setShowResetConfirm(false)} />
          <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-xs mx-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
              Start a new project?
            </h3>
            <p className="text-sm text-warm-gray mb-4">
              Your current project has not been exported. Any unsaved work will be lost.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await db.projectData.clear();
                  await db.projects.clear();
                  window.location.reload();
                }}
                className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg font-heading font-bold text-sm hover:bg-red-600 transition-colors"
              >
                Discard & Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CreateOrgDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (org: { id: string; slug: string; name: string; role: OrgRole; memberCount: number; projectCount: number; createdAt: number }) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 63);
  const effectiveSlug = slugTouched ? slug : autoSlug;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await createOrg({ slug: effectiveSlug, name: name.trim() });
      onCreated({
        ...res.organization,
        memberCount: 1,
        projectCount: 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create organization');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-sm w-full mx-4">
        <h3 className="font-heading font-bold text-base text-dark-brown mb-3">
          Create organization
        </h3>
        <form onSubmit={handleSubmit}>
          <label className="block text-xs font-semibold text-dark-brown mb-1">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Streamline Transit"
            className="w-full mb-3 px-3 py-2 rounded-lg border border-sand focus:border-coral focus:outline-none text-sm"
            required
          />
          <label className="block text-xs font-semibold text-dark-brown mb-1">Slug</label>
          <input
            value={effectiveSlug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="streamline-transit"
            className="w-full mb-3 px-3 py-2 rounded-lg border border-sand focus:border-coral focus:outline-none text-sm font-mono"
            required
          />
          {error && (
            <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !effectiveSlug}
              className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function initialsFromName(nameOrEmail: string): string {
  const src = (nameOrEmail || '').trim();
  if (!src) return '?';
  if (src.includes('@')) {
    return src[0]!.toUpperCase();
  }
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
