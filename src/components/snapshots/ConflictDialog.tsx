import { useEffect, useState } from 'react';
import { AuthButton } from '../auth/AuthButton';
import { Modal } from '../ui/Modal';
import { loadProjectFromServer, forceSaveWithLatest } from '../../db/serverPersistence';

interface ConflictEventDetail {
  projectId: string;
  currentVersion: number;
}

export function ConflictDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent<ConflictEventDetail>).detail;
      if (detail?.projectId !== projectId) return;
      setOpen(true);
    };
    window.addEventListener('gb:working-state-conflict', onConflict);
    return () => window.removeEventListener('gb:working-state-conflict', onConflict);
  }, [projectId]);

  if (!open) return null;

  const loadTheirs = async () => {
    setBusy(true);
    setError(null);
    try {
      await loadProjectFromServer(projectId);
      setOpen(false);
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not reload');
    } finally {
      setBusy(false);
    }
  };

  const keepMine = async () => {
    setBusy(true);
    setError(null);
    try {
      await forceSaveWithLatest(projectId);
      setOpen(false);
    } catch (err) {
      setError((err as Error)?.message ?? 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      // Conflict resolution is forced: no backdrop/Escape dismiss, no × — the
      // user must pick one of the two actions.
      onClose={() => {}}
      dismissable={false}
      showClose={false}
      maxWidthClassName="max-w-md"
      title="Feed edited elsewhere"
      description={
        <>
          Someone edited this feed on another device. Your changes are still in your browser — you
          can either reload the server's version (losing your local edits) or overwrite the server
          version (losing theirs).
        </>
      }
      footer={
        <>
          <AuthButton variant="secondary" onClick={loadTheirs} disabled={busy}>
            Reload theirs
          </AuthButton>
          <AuthButton onClick={keepMine} disabled={busy}>
            Keep mine
          </AuthButton>
        </>
      }
    >
      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
    </Modal>
  );
}
