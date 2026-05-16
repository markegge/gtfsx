import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { ApiError } from '../../services/authApi';
import { createProject, saveWorkingState } from '../../services/projectsApi';
import { buildSnapshot, setCurrentWorkingStateVersion } from '../../db/serverPersistence';
import { roleAtLeast } from '../../services/orgsApi';
import { db } from '../../db/dexie';
import { LAST_PROJECT_KEY } from '../../db/persistence';

export function SaveAsDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const projectName = useStore((s) => s.projectName);
  const userOrgs = useStore((s) => s.userOrgs);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const setActiveServerProject = useStore((s) => s.setActiveServerProject);
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const setProjectId = useStore((s) => s.setProjectId);
  const setProjectName = useStore((s) => s.setProjectName);
  const markSaved = useStore((s) => s.markSaved);

  const [name, setName] = useState(
    projectName && projectName !== 'Untitled Feed' ? projectName : '',
  );
  const editorOrgs = userOrgs.filter((o) => roleAtLeast(o.role, 'editor'));
  const initialOwner =
    activeWorkspace.type === 'org' && editorOrgs.some((o) => o.id === activeWorkspace.orgId)
      ? `org:${activeWorkspace.orgId}`
      : 'user';
  const [owner, setOwner] = useState<string>(initialOwner);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Capture the anonymous-draft projectId BEFORE we overwrite it with the
    // server's. After a successful save we drop that IDB row so the same
    // draft doesn't reappear as a "local feed available for import" on the
    // /feeds dashboard (which used to surface it as a phantom duplicate).
    const previousProjectId = useStore.getState().projectId;
    try {
      const ownerArg: { type: 'user' } | { type: 'org'; id: string } = owner === 'user'
        ? { type: 'user' }
        : { type: 'org', id: owner.slice('org:'.length) };

      const project = await createProject({
        name: name.trim(),
        owner: ownerArg,
      });

      // Reflect the new server-backed identity in the store so the snapshot
      // we serialize carries the right project id.
      setProjectId(project.id);
      setProjectName(project.name);

      const snapshot = buildSnapshot();
      const { workingStateVersion } = await saveWorkingState(project.id, snapshot, 0);
      setCurrentWorkingStateVersion(project.id, workingStateVersion);
      setActiveServerProject(project.id);
      upsertFeedProject({ ...project, workingStateVersion });
      markSaved();

      // Anonymous draft is now promoted to a server-backed project. Drop the
      // IDB rows + the localStorage pointer so it doesn't linger.
      if (previousProjectId && previousProjectId !== project.id) {
        try {
          await db.projects.delete(previousProjectId);
          await db.projectData.delete(previousProjectId);
          if (localStorage.getItem(LAST_PROJECT_KEY) === previousProjectId) {
            localStorage.removeItem(LAST_PROJECT_KEY);
          }
        } catch {
          // Non-fatal — the next visit's import filter still de-dupes by name+id.
        }
      }

      // Sync the workspace switcher to the chosen destination so the header
      // chip + "current workspace" indicator match the feed's actual owner.
      // Without this the user can save into Org X but still see "My personal
      // feeds" highlighted as active.
      if (ownerArg.type === 'org') {
        const org = userOrgs.find((o) => o.id === ownerArg.id);
        if (org) setActiveWorkspace({ type: 'org', orgId: org.id, role: org.role });
      } else {
        setActiveWorkspace({ type: 'personal' });
      }

      navigate(`/feeds/${encodeURIComponent(project.slug)}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Save failed';
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
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">Save feed</h3>
        <p className="text-xs text-warm-gray mb-4">
          Saves your current work to the cloud as a new feed you can edit from any device.
        </p>

        <label className="block text-xs font-semibold text-dark-brown mb-1">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Transit Feed"
          required
          className="w-full mb-3 px-3 py-2 rounded-lg border border-sand focus:border-coral focus:outline-none text-sm"
        />

        {editorOrgs.length > 0 && (
          <>
            <label className="block text-xs font-semibold text-dark-brown mb-1">Workspace</label>
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="w-full mb-3 px-3 py-2 rounded-lg border border-sand focus:border-coral focus:outline-none text-sm bg-white"
            >
              <option value="user">My personal feeds</option>
              {editorOrgs.map((o) => (
                <option key={o.id} value={`org:${o.id}`}>
                  {o.name}
                </option>
              ))}
            </select>
          </>
        )}

        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-sand text-brown font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="px-4 py-2 rounded-lg bg-coral text-white font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
