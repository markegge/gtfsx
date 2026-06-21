import { useNavigate } from 'react-router-dom';
import { db } from '../../db/dexie';
import { useStore } from '../../store';

/**
 * Shared logo + "GTFS·X" wordmark. Used by every page's top bar.
 *
 * - In the editor (default), clicking checks for unsaved work and pops a
 *   reset dialog before going home.
 * - On non-editor pages, pass `mode="link"` to just navigate to '/'.
 *
 * The tagline is rendered separately and is hidden on narrow viewports.
 */
export function AppBrand({
  mode = 'editor',
  onResetRequest,
  showTagline = true,
  taglineClassName = 'hidden min-[1100px]:inline',
}: {
  mode?: 'editor' | 'link';
  onResetRequest?: () => void;
  showTagline?: boolean;
  taglineClassName?: string;
}) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (mode === 'link') {
      navigate('/');
      return;
    }
    // Editor mode: only warn if there are actual unsaved changes. A
    // freshly-imported project that hasn't been touched is not "unsaved
    // work" — wiping it clean is fine.
    const state = useStore.getState();
    if (state.isDirty && onResetRequest) {
      onResetRequest();
    } else {
      // Open a FRESH EDITOR session — not the marketing landing at '/'. Hard-load
      // /editor (not reload(): on a server-backed route /feeds/:slug a reload just
      // re-loads the same feed) so the logo always drops into a clean, empty
      // project; the active workspace persists in localStorage so a signed-in
      // user stays in the same org.
      db.projectData
        .clear()
        .then(() => db.projectBulk.clear())
        .then(() => db.projects.clear())
        .then(() => {
          window.location.href = `${import.meta.env.BASE_URL}editor`;
        });
    }
  };

  return (
    <div className="flex items-center gap-3 shrink-0">
      <button
        onClick={handleClick}
        className="flex items-center hover:opacity-80 transition-opacity"
        title={mode === 'editor' ? 'Start new project' : 'Home'}
      >
        <img
          src={`${import.meta.env.BASE_URL}gtfsx-lockup.svg`}
          alt="GTFS·X"
          height="36"
          className="shrink-0 h-9 w-auto"
        />
      </button>
      {showTagline && (
        <span
          className={`${taglineClassName} text-sm font-medium text-warm-gray border-l border-sand pl-3 whitespace-nowrap`}
        >
          GTFS Editor • Route Planner
        </span>
      )}
    </div>
  );
}
