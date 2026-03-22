import { useState } from 'react';
import { useStore } from '../../store';
import { ImportDialog } from '../import-export/ImportDialog';
import { ExportDialog } from '../import-export/ExportDialog';

export function TopBar() {
  const { projectName, setProjectName, lastSavedAt, isDirty } = useStore();
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [editing, setEditing] = useState(false);

  const saveStatus = isDirty ? 'Unsaved changes' : lastSavedAt ? 'Saved' : 'New project';

  return (
    <>
      <div className="h-14 bg-white border-b border-sand flex items-center px-5 gap-4 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 font-heading font-extrabold text-xl text-coral">
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
          Transit Feeds
        </div>

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
      </div>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
    </>
  );
}
