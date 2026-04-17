import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { setupAutoSave, loadProject } from './db/persistence';
import {
  loadProjectFromServer,
  setupServerAutoSave,
  type ServerAutoSaveHandle,
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
  useEffect(() => {
    if (demo) {
      loadDemoFeed().catch(console.error);
      return;
    }
    const projectId = useStore.getState().projectId;
    loadProject(projectId).catch(() => {});
    const unsub = setupAutoSave();
    return unsub;
  }, [demo, location.pathname]);

  return <AppShell />;
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
  const [autoSaveHandle, setAutoSaveHandle] = useState<ServerAutoSaveHandle | null>(null);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) {
      navigate(`/login?next=${encodeURIComponent(`/feeds/${slug ?? ''}`)}`, { replace: true });
      return;
    }
    let cancelled = false;
    let localUnsub: (() => void) | null = null;
    let serverHandle: ServerAutoSaveHandle | null = null;
    const resolveAndLoad = async () => {
      try {
        let proj = feedsProjects.find((p) => p.slug === slug);
        if (!proj) {
          const res = await listProjects(true);
          setFeedsProjects(res.projects, res.quota.warning);
          proj = res.projects.find((p) => p.slug === slug);
        }
        if (cancelled) return;
        if (!proj) {
          setError('Feed not found');
          return;
        }
        setProjectId(proj.id);
        setActiveServerProject(proj.id);
        await loadProjectFromServer(proj.id);
        if (cancelled) return;
        useStore.getState().setProjectName(proj.name);
        useStore.getState().setProjectId(proj.id);
        serverHandle = setupServerAutoSave(proj.id);
        setAutoSaveHandle(serverHandle);
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
      if (serverHandle) serverHandle.unsubscribe();
      setAutoSaveHandle(null);
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
      {projectId && <ConflictDialog projectId={projectId} autoSave={autoSaveHandle} />}
    </>
  );
}

function App() {
  useEffect(() => {
    if (backendEnabled) {
      useStore.getState().hydrateAuth().catch(() => {});
    }
  }, []);

  if (!backendEnabled) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<EditorRoute />} />
          <Route path="/demo" element={<EditorRoute demo />} />
          <Route path="/login" element={<BackendDisabledPage />} />
          <Route path="/signup" element={<BackendDisabledPage />} />
          <Route path="/feeds" element={<BackendDisabledPage />} />
          <Route path="/feeds/*" element={<BackendDisabledPage />} />
          <Route path="/account" element={<BackendDisabledPage />} />
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
        <Route path="/feeds" element={<MyFeedsPage />} />
        <Route path="/feeds/:slug" element={<ServerEditorRoute />} />
        <Route path="/feeds/*" element={<Navigate to="/feeds" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
