import { useHistoryUi, undo, redo } from '../../store/history';

// Undo / redo buttons for the editor top bar (#49). State comes from the
// dedicated history UI store; the actual stacks + patch apply live in
// store/history.ts. Keyboard shortcuts (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z) are wired
// in AppShell so they work without the buttons focused.

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

export function UndoRedoControls() {
  const canUndo = useHistoryUi((s) => s.canUndo);
  const canRedo = useHistoryUi((s) => s.canRedo);
  const undoLabel = useHistoryUi((s) => s.undoLabel);
  const redoLabel = useHistoryUi((s) => s.redoLabel);

  const btn =
    'w-9 h-9 rounded-md flex items-center justify-center text-warm-gray ' +
    'hover:bg-cream hover:text-coral transition-colors disabled:opacity-30 ' +
    'disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-warm-gray';

  return (
    <div className="hidden min-[760px]:flex items-center shrink-0">
      <button
        type="button"
        onClick={() => undo()}
        disabled={!canUndo}
        aria-label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
        title={undoLabel ? `Undo: ${undoLabel} (${MOD}+Z)` : `Undo (${MOD}+Z)`}
        className={btn}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => redo()}
        disabled={!canRedo}
        aria-label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
        title={redoLabel ? `Redo: ${redoLabel} (${MOD}+Shift+Z)` : `Redo (${MOD}+Shift+Z)`}
        className={btn}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
        </svg>
      </button>
    </div>
  );
}
