import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { SaveAsDialog } from './components/feeds/SaveAsDialog';
import { setupAutoSave, loadProject, LAST_PROJECT_KEY } from './db/persistence';
import {
  loadProjectFromServer,
} from './db/serverPersistence';
import { listProjects } from './services/projectsApi';
import { ApiError } from './services/authApi';
import { useStore } from './store';
import { importGtfsZip, loadImportIntoStore } from './services/gtfsImport';
import { LoginPage } from './components/auth/LoginPage';
import { SignupPage } from './components/auth/SignupPage';
import { VerifyEmailPage } from './components/auth/VerifyEmailPage';
import { MagicLinkPage } from './components/auth/MagicLinkPage';
import { ResetPasswordPage } from './components/auth/ResetPasswordPage';
import { ChangeEmailPage } from './components/auth/ChangeEmailPage';
import { AccountSettingsPage } from './components/auth/AccountSettingsPage';
import { NotFoundPage } from './components/misc/NotFoundPage';
import { BackendDisabledPage } from './components/misc/BackendDisabledPage';
import { MyFeedsPage } from './components/feeds/MyFeedsPage';
import { ConflictDialog } from './components/versions/ConflictDialog';
import { AdminDashboardPage } from './components/admin/AdminDashboardPage';
import { AdminUsersPage } from './components/admin/AdminUsersPage';
import { AdminUserDetailPage } from './components/admin/AdminUserDetailPage';
import { AdminOrgsPage } from './components/admin/AdminOrgsPage';
import { AdminOrgDetailPage } from './components/admin/AdminOrgDetailPage';
import { AdminAuditPage } from './components/admin/AdminAuditPage';
import { ImpersonationBanner } from './components/admin/ImpersonationBanner';
import { OrgSettingsPage } from './components/orgs/OrgSettingsPage';
import { AcceptInvitationPage } from './components/orgs/AcceptInvitationPage';
import { RtBreakageDialog } from './components/distribution/RtBreakageDialog';
import { PricingPage } from './components/billing/PricingPage';
import { AccountBillingPage } from './components/billing/AccountBillingPage';
import { OrgBillingPage } from './components/billing/OrgBillingPage';
import { WelcomePlanPage } from './components/billing/WelcomePlanPage';
import { backendEnabled } from './utils/featureFlags';

async function loadDemoFeed() {
  const res = await fetch(`${import.meta.env.BASE_URL}streamline.zip`);
  if (!res.ok) throw new Error('Demo feed not found');
  const blob = await res.blob();
  const file = new File([blob], 'streamline.zip', { type: 'application/zip' });
  const data = await importGtfsZip(file);
  loadImportIntoStore(data);
  useStore.getState().setProjectName('Streamline Transit — Demo');
}

function EditorRoute({ demo = false }: { demo?: boolean }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const authChecked = useStore((s) => s.authChecked);
  const currentUser = useStore((s) => s.currentUser);

  useEffect(() => {
    if (demo) {
      loadDemoFeed().catch(console.error);
      return;
    }
    // Recover the last autosaved anonymous draft if one exists, so refresh
    // doesn't silently drop the user's work. The store initializes
    // projectId to a fresh UUID on every page load, so without this we'd
    // always miss the IndexedDB row and boot a blank feed.
    let projectId: string;
    try {
      const stored = localStorage.getItem(LAST_PROJECT_KEY);
      projectId = stored || useStore.getState().projectId;
      if (stored) useStore.getState().setProjectId(stored);
    } catch {
      projectId = useStore.getState().projectId;
    }
    loadProject(projectId).catch(() => {});
    const unsub = setupAutoSave();
    return unsub;
  }, [demo, location.pathname]);

  // After a "save → sign in" round-trip, the login redirect lands here with
  // ?save=1. Show the Save-As dialog as long as the param is present and
  // auth is hydrated; closing the dialog strips the param.
  const showSaveAs =
    backendEnabled &&
    authChecked &&
    !!currentUser &&
    searchParams.get('save') === '1';

  const dismissSaveAs = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('save');
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <AppShell />
      {showSaveAs && <SaveAsDialog onClose={dismissSaveAs} />}
    </>
  );
}

function ServerEditorRoute() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const authChecked = useStore((s) => s.authChecked);
  const currentUser = useStore((s) => s.currentUser);
  const setActiveServerProject = useStore((s) => s.setActiveServerProject);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const setFeedsProjects = useStore((s) => s.setFeedsProjects);
  const restoredBanner = useStore((s) => s.restoredBanner);
  const setRestoredBanner = useStore((s) => s.setRestoredBanner);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) {
      navigate(`/login?next=${encodeURIComponent(`/feeds/${slug ?? ''}`)}`, { replace: true });
      return;
    }
    let cancelled = false;
    let localUnsub: (() => void) | null = null;
    const resolveAndLoad = async () => {
      try {
        let proj = feedsProjects.find((p) => p.slug === slug);
        if (!proj) {
          // Slugs are unique per workspace, not globally — try the active
          // workspace first, then fall back to personal so a direct URL
          // hit (e.g. shared link) still resolves when the user lands in
          // a workspace that doesn't own the slug.
          const ws = useStore.getState().activeWorkspace;
          const primaryScope = ws.type === 'org' ? `org:${ws.orgId}` : 'personal';
          const tries = primaryScope === 'personal' ? ['personal'] : [primaryScope, 'personal'];
          for (const scope of tries) {
            const res = await listProjects({ includeArchived: true, scope });
            setFeedsProjects(res.projects, res.quota.warning);
            proj = res.projects.find((p) => p.slug === slug);
            if (proj) break;
          }
        }
        if (cancelled) return;
        if (!proj) {
          setError('Feed not found');
          return;
        }
        setProjectId(proj.id);
        setActiveServerProject(proj.id);
        // Set project metadata in the store BEFORE loading the snapshot,
        // so the markSaved() at the end of the snapshot apply also covers
        // the name/id assignment. Setting them after would re-mark dirty.
        useStore.getState().setProjectName(proj.name);
        useStore.getState().setProjectId(proj.id);
        await loadProjectFromServer(proj.id);
        if (cancelled) return;
        localUnsub = setupAutoSave();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : 'Could not load feed';
        setError(msg);
      }
    };
    resolveAndLoad();
    return () => {
      cancelled = true;
      if (localUnsub) localUnsub();
      setActiveServerProject(null);
      setRestoredBanner(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, authChecked, currentUser]);

  if (!authChecked) {
    return <div className="p-8 text-warm-gray">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-8">
        <div className="max-w-xl mx-auto bg-white border border-sand rounded-2xl p-6">
          <h2 className="font-heading font-bold text-lg text-dark-brown mb-2">Couldn't open feed</h2>
          <p className="text-sm text-warm-gray mb-4">{error}</p>
          <button
            onClick={() => navigate('/feeds')}
            className="px-4 py-2 rounded-lg bg-coral text-white font-heading font-bold text-sm hover:bg-[#d4603a]"
          >
            Back to My Feeds
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {restoredBanner && (
        <div className="px-4 py-2 bg-teal-light text-teal text-sm flex items-center gap-3">
          <span className="flex-1">{restoredBanner}</span>
          <button
            onClick={() => setRestoredBanner(null)}
            className="w-7 h-7 rounded-md hover:bg-white/50"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <AppShell />
      {projectId && <ConflictDialog projectId={projectId} />}
    </>
  );
}

function App() {
  useEffect(() => {
    if (backendEnabled) {
      useStore.getState().hydrateAuth().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!useStore.getState().isDirty) return;
      e.preventDefault();
      // Most modern browsers ignore the message and show a generic prompt,
      // but assigning returnValue is what triggers the prompt at all.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (!backendEnabled) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<EditorRoute />} />
          <Route path="/demo" element={<EditorRoute demo />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/login" element={<BackendDisabledPage />} />
          <Route path="/signup" element={<BackendDisabledPage />} />
          <Route path="/feeds" element={<BackendDisabledPage />} />
          <Route path="/feeds/*" element={<BackendDisabledPage />} />
          <Route path="/account" element={<BackendDisabledPage />} />
          <Route path="/account/*" element={<BackendDisabledPage />} />
          <Route path="/verify-email" element={<BackendDisabledPage />} />
          <Route path="/magic-link" element={<BackendDisabledPage />} />
          <Route path="/reset-password" element={<BackendDisabledPage />} />
          <Route path="/change-email" element={<BackendDisabledPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <ImpersonationBanner />
      <Routes>
        <Route path="/" element={<EditorRoute />} />
        <Route path="/demo" element={<EditorRoute demo />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/magic-link" element={<MagicLinkPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/change-email" element={<ChangeEmailPage />} />
        <Route path="/account" element={<AccountSettingsPage />} />
        <Route path="/account/billing" element={<AccountBillingPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/welcome/plan" element={<WelcomePlanPage />} />
        <Route path="/upgrade" element={<WelcomePlanPage />} />
        <Route path="/feeds" element={<MyFeedsPage />} />
        <Route path="/feeds/:slug" element={<ServerEditorRoute />} />
        <Route path="/feeds/*" element={<Navigate to="/feeds" replace />} />
        <Route path="/orgs/accept" element={<AcceptInvitationPage />} />
        <Route path="/orgs/:slug/billing" element={<OrgBillingPage />} />
        <Route path="/orgs/:slug" element={<OrgSettingsPage />} />
        <Route path="/admin" element={<AdminDashboardPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/users/:id" element={<AdminUserDetailPage />} />
        <Route path="/admin/orgs" element={<AdminOrgsPage />} />
        <Route path="/admin/orgs/:id" element={<AdminOrgDetailPage />} />
        <Route path="/admin/audit" element={<AdminAuditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {/* Global RT-breakage dialog — listens for `gb:rt-breakage` events from
          the PublishPanel and confirms before publishing a version that would
          break the project's registered GTFS-RT feed. */}
      <RtBreakageDialog />
    </BrowserRouter>
  );
}

export default App;
