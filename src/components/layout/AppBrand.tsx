import { useNavigate } from 'react-router-dom';
import { db } from '../../db/dexie';
import { useStore } from '../../store';

/**
 * Shared logo + "GTFS Builder" wordmark. Used by every page's top bar.
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
      db.projectData
        .clear()
        .then(() => db.projects.clear())
        .then(() => window.location.reload());
    }
  };

  return (
    <div className="flex items-center gap-3 shrink-0">
      <button
        onClick={handleClick}
        className="flex items-center gap-2 font-heading font-extrabold text-xl text-coral hover:opacity-80 transition-opacity whitespace-nowrap"
        title={mode === 'editor' ? 'Start new project' : 'Home'}
      >
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
          <rect width="32" height="32" rx="8" fill="#E8734A" />
          <path
            d="M6 24 C10 24, 10 8, 16 8 S22 24, 26 24"
            stroke="#FFF8F0"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="8" cy="22" r="2.5" fill="#FFF8F0" />
          <circle cx="16" cy="8" r="2.5" fill="#FFF8F0" />
          <circle cx="24" cy="22" r="2.5" fill="#FFF8F0" />
          <rect x="12" y="14" width="8" height="5" rx="1.5" fill="#FFF8F0" />
          <rect x="13.5" y="15" width="2" height="2" rx="0.5" fill="#E8734A" />
          <rect x="16.5" y="15" width="2" height="2" rx="0.5" fill="#E8734A" />
          <circle cx="14" cy="19.5" r="1" fill="#FFF8F0" />
          <circle cx="18" cy="19.5" r="1" fill="#FFF8F0" />
        </svg>
        GTFS Builder
      </button>
      {showTagline && (
        <span
          className={`${taglineClassName} text-sm font-medium text-warm-gray border-l border-sand pl-3 whitespace-nowrap`}
        >
          The Free Online GTFS Feed Editor
        </span>
      )}
    </div>
  );
}
