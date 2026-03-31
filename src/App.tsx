import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { setupAutoSave, loadProject } from './db/persistence';
import { useStore } from './store';
import { importGtfsZip, loadImportIntoStore } from './services/gtfsImport';

async function loadDemoFeed() {
  const res = await fetch(`${import.meta.env.BASE_URL}streamline.zip`);
  if (!res.ok) throw new Error('Demo feed not found');
  const blob = await res.blob();
  const file = new File([blob], 'streamline.zip', { type: 'application/zip' });
  const data = await importGtfsZip(file);
  loadImportIntoStore(data);
  useStore.getState().setProjectName('Streamline Transit — Demo');
}

function App() {
  useEffect(() => {
    const isDemo = window.location.pathname === '/demo';

    if (isDemo) {
      // Load demo feed fresh on every visit; skip auto-save
      loadDemoFeed().catch(console.error);
      return;
    }

    // Normal mode: restore last project and auto-save
    const projectId = useStore.getState().projectId;
    loadProject(projectId).catch(() => {});
    const unsub = setupAutoSave();
    return unsub;
  }, []);

  return <AppShell />;
}

export default App;
