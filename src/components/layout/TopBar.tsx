import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { ImportDialog } from '../import-export/ImportDialog';
import { ExportDialog } from '../import-export/ExportDialog';
import { HelpDialog } from '../help/HelpDialog';
import { db } from '../../db/dexie';
import { logout as apiLogout } from '../../services/authApi';
import { backendEnabled } from '../../utils/featureFlags';

export function TopBar() {
  const { projectName, setProjectName, lastSavedAt, isDirty } = useStore();
  const currentUser = useStore((s) => s.currentUser);
  const clearAuth = useStore((s) => s.clearAuth);
  const navigate = useNavigate();
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

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
                className="bg-white rounded-xl shadow-lg border border-sand p-2 w-56 z-50"
              >
                <div className="px-3 py-2 border-b border-sand mb-1">
                  <div className="text-sm font-semibold text-dark-brown truncate">
                    {currentUser.displayName}
                  </div>
                  <div className="text-xs text-warm-gray truncate">{currentUser.email}</div>
                </div>
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
