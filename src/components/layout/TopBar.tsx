import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { ImportDialog } from '../import-export/ImportDialog';
import { ExportDialog } from '../import-export/ExportDialog';
import { SaveAsDialog } from '../feeds/SaveAsDialog';
import { db } from '../../db/dexie';
import { ApiError } from '../../services/authApi';
import { patchProject } from '../../services/projectsApi';
import { saveProjectNow } from '../../db/serverPersistence';
import { backendEnabled } from '../../utils/featureFlags';
import { AppBrand } from './AppBrand';
import { ScenarioSwitcher } from './ScenarioSwitcher';
import { UserMenu, UserMenuItems } from './UserMenu';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

// Re-export RoleBadge for callers that imported it from TopBar previously.
export { RoleBadge } from './UserMenu';

export function TopBar() {
  const { projectName, setProjectName, lastSavedAt, isDirty } = useStore();
  const currentUser = useStore((s) => s.currentUser);
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const routesCount = useStore((s) => s.routes.length);
  const stopsCount = useStore((s) => s.stops.length);
  const agenciesCount = useStore((s) => s.agencies.length);
  // When ≥1 saved scenario exists, the header shows the scenario switcher in
  // place of the "GTFS Editor • Route Planner" tagline. Scenarios are Agency+,
  // so the switcher only appears (and the tagline only yields to it) for plans
  // that unlock the feature — matching ScenarioSwitcher's own gate.
  const editorPlan = useEditorPlan();
  const hasSavedScenarios = useStore((s) => s.visibilitySets.length > 0);
  const hasScenarios = hasSavedScenarios && planHasFeature(editorPlan, 'scenarios');
  const navigate = useNavigate();
  // /demo is a read-only preview surface — drop the Save button so
  // visitors don't get prompted to upgrade or create an account just
  // to exit a "save attempt." Import / Export and the rest of the
  // editor stay visible.
  const isDemo = useLocation().pathname.startsWith('/demo');
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Mobile-only: Save / Import / Export collapse into a single overflow menu
  // (alongside the user-menu avatar) so the top bar stops overflowing on
  // phones. Below the same 600px breakpoint the rails use.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Status reflects BACKEND save state — IndexedDB autosaves don't promote
  // a draft to "Saved." Anonymous editors get a distinct label so the dot
  // never claims their work is durable in the cloud.
  const serverBacked = !!activeServerProjectId;
  const saveStatus = !serverBacked
    ? 'Local draft'
    : isDirty
      ? 'Unsaved changes'
      : lastSavedAt
        ? 'Saved'
        : 'New project';
  const saveDotClass = !serverBacked
    ? 'bg-warm-gray/50'
    : isDirty
      ? 'bg-gold'
      : 'bg-teal';

  // Feed is considered "empty" (and Export disabled) when there's nothing
  // worth exporting — no agency, no routes, no stops.
  const hasContent = agenciesCount > 0 || routesCount > 0 || stopsCount > 0;

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
      <div className="h-14 bg-white border-b border-sand flex items-center px-3 sm:px-5 gap-2 sm:gap-3 shrink-0 min-w-0">
        <AppBrand onResetRequest={() => setShowResetConfirm(true)} showTagline={!hasScenarios} />

        {/* Scenario switcher — replaces the tagline once the user saves a
            visibility set. Self-hides when none exist. */}
        <div className="hidden min-[600px]:flex shrink-0">
          <ScenarioSwitcher />
        </div>

        {/* Project name */}
        {editing ? (
          <input
            autoFocus
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
            className="font-semibold text-dark-brown px-3 py-1 bg-white border-2 border-coral rounded-md text-sm outline-none min-w-0 w-32 md:w-44"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="font-semibold text-dark-brown px-3 py-1 bg-sand rounded-md text-sm hover:bg-coral-light transition-colors truncate max-w-[7rem] md:max-w-[10rem] shrink-0"
            title={projectName}
          >
            {projectName}
          </button>
        )}

        {/* Save status — hides on small viewports (second to go, after the tagline). */}
        <div className="hidden min-[900px]:flex items-center gap-1.5 text-xs text-warm-gray whitespace-nowrap shrink-0">
          <div className={`w-1.5 h-1.5 rounded-full ${saveDotClass}`} />
          {saveStatus}
        </div>

        {/* Save button — hidden on phones; folded into the mobile menu below.
            Also hidden on /demo (read-only preview, no project to save). */}
        {backendEnabled && !isDemo && (
          <button
            onClick={handleSaveClick}
            disabled={saving || (!isDirty && !!activeServerProjectId)}
            className="hidden min-[600px]:inline-block px-3 py-1.5 rounded-lg font-heading font-bold text-xs bg-teal text-white hover:bg-[#0e7e75] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
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
          <span className="hidden lg:inline text-xs text-red-600 truncate max-w-[14rem]" title={saveError}>
            {saveError}
          </span>
        )}

        <div className="flex-1" />

        {/* Editor actions — hidden on phones; available in the mobile menu. */}
        <button
          onClick={() => setShowImport(true)}
          className="hidden min-[600px]:inline-block px-3 sm:px-4 py-2 rounded-lg font-heading font-bold text-sm bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors whitespace-nowrap shrink-0"
        >
          Import
        </button>
        <button
          onClick={() => setShowExport(true)}
          disabled={!hasContent}
          title={hasContent ? 'Export GTFS feed' : 'Add some routes or stops before exporting'}
          className="hidden min-[600px]:inline-block px-3 sm:px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-coral"
        >
          <span className="hidden sm:inline">Export GTFS</span>
          <span className="sm:hidden">Export</span>
        </button>

        {/* Mobile-only overflow menu containing Save / Import / Export. */}
        <div className="min-[600px]:hidden relative shrink-0">
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Menu"
            className="w-9 h-9 rounded-md flex items-center justify-center text-warm-gray hover:bg-cream hover:text-coral transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {mobileMenuOpen && (
            <>
              {/* Click-outside backdrop. */}
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMobileMenuOpen(false)}
                aria-hidden
              />
              <div className="absolute right-0 top-full mt-1 z-40 w-64 max-h-[80vh] overflow-y-auto bg-white border border-sand rounded-xl shadow-lg p-2 flex flex-col">
                {backendEnabled && !isDemo && (
                  <button
                    onClick={() => { setMobileMenuOpen(false); handleSaveClick(); }}
                    disabled={saving || (!isDirty && !!activeServerProjectId)}
                    className="text-left px-3 py-2 rounded-md text-sm font-heading font-semibold text-dark-brown hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
                {/* Scenario switcher — Agency+ only, self-hides when no scenarios */}
                {hasScenarios && (
                  <>
                    <div className="border-t border-sand my-1" />
                    <div className="px-1 py-0.5">
                      <ScenarioSwitcher />
                    </div>
                    <div className="border-t border-sand my-1" />
                  </>
                )}
                <button
                  onClick={() => { setMobileMenuOpen(false); setShowImport(true); }}
                  className="text-left px-3 py-2 rounded-md text-sm font-heading font-semibold text-dark-brown hover:bg-cream"
                >
                  Import
                </button>
                <button
                  onClick={() => { setMobileMenuOpen(false); setShowExport(true); }}
                  disabled={!hasContent}
                  title={hasContent ? 'Export GTFS feed' : 'Add some routes or stops before exporting'}
                  className="text-left px-3 py-2 rounded-md text-sm font-heading font-semibold text-coral hover:bg-coral-light disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Export GTFS
                </button>
                {backendEnabled && (
                  <>
                    <div className="border-t border-sand my-1" />
                    {/* All UserMenu items inline — account, workspaces, sign in/out, etc. */}
                    <UserMenuItems onClose={() => setMobileMenuOpen(false)} />
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* UserMenu (avatar) — desktop only; on phones its items live inside
            the hamburger above so the bar stops overflowing. */}
        <div className="hidden min-[600px]:flex">
          <UserMenu />
        </div>
      </div>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showSaveAs && <SaveAsDialog onClose={() => setShowSaveAs(false)} />}

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
                  await db.projectBulk.clear();
                  await db.projects.clear();
                  // Navigate home (not reload) so resetting from a server-backed
                  // editor route lands on a fresh project instead of re-loading
                  // the same feed. Workspace persists in localStorage.
                  window.location.href = import.meta.env.BASE_URL;
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
