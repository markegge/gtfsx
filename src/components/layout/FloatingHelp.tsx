import { useState } from 'react';
import { HelpDialog } from '../help/HelpDialog';

/**
 * Floating "?" help button. Renders in the bottom-right of the editor over
 * the map, replacing the topbar slot that competed with workspace controls.
 */
export function FloatingHelp() {
  const [show, setShow] = useState(false);
  return (
    <>
      <button
        onClick={() => setShow(true)}
        title="Help & shortcuts"
        aria-label="Help"
        className="absolute bottom-10 left-3 h-8 px-3 rounded-full bg-white border border-sand shadow-md text-warm-gray hover:text-coral hover:border-coral hover:shadow-lg flex items-center gap-1.5 text-xs font-heading font-bold uppercase tracking-wide transition-all z-30"
      >
        <span className="text-sm leading-none">?</span>
        <span>Help</span>
      </button>
      {show && <HelpDialog onClose={() => setShow(false)} />}
    </>
  );
}
