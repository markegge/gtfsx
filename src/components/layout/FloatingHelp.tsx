import { useNavigate } from 'react-router-dom';

/**
 * Floating "?" help button. Renders in the bottom-left of the editor over
 * the map; clicking it opens the /help landing page (quick-start, docs,
 * forum, and plan-conditional support contact).
 */
export function FloatingHelp() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate('/help')}
      title="Help &amp; support"
      aria-label="Help"
      className="absolute bottom-10 left-3 h-8 px-3 rounded-full bg-white border border-sand shadow-md text-warm-gray hover:text-coral hover:border-coral hover:shadow-lg flex items-center gap-1.5 text-xs font-heading font-bold uppercase tracking-wide transition-all z-30"
    >
      <span className="text-sm leading-none">?</span>
      <span>Help</span>
    </button>
  );
}
