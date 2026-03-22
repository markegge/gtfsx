
import { useStore } from '../../store';
import { TimetableGrid } from '../timetable/TimetableGrid';
import { ValidationPanel } from '../validation/ValidationPanel';

export function BottomPanel() {
  const { bottomPanelOpen, bottomPanelTab, setBottomPanelTab, toggleBottomPanel } = useStore();

  return (
    <div
      className={`bg-white border-t border-sand flex flex-col transition-all duration-200 shrink-0
        ${bottomPanelOpen ? 'h-[260px]' : 'h-10'}`}
    >
      {/* Header */}
      <div className="flex items-center px-4 h-10 gap-4 shrink-0 border-b border-sand cursor-pointer select-none"
        onClick={() => toggleBottomPanel()}
      >
        <span className="text-xs text-warm-gray">{bottomPanelOpen ? '▼' : '▲'}</span>
        {(['timetable', 'validation'] as const).map((tab) => (
          <button
            key={tab}
            onClick={(e) => {
              e.stopPropagation();
              setBottomPanelTab(tab);
              if (!bottomPanelOpen) toggleBottomPanel();
            }}
            className={`text-[13px] font-heading font-semibold px-3 py-1 rounded-md transition-colors
              ${bottomPanelTab === tab && bottomPanelOpen
                ? 'bg-coral-light text-coral'
                : 'text-warm-gray hover:text-dark-brown'
              }`}
          >
            {tab === 'timetable' ? 'Timetable' : 'Validation'}
          </button>
        ))}
      </div>

      {/* Content */}
      {bottomPanelOpen && (
        <div className="flex-1 overflow-auto">
          {bottomPanelTab === 'timetable' && <TimetableGrid />}
          {bottomPanelTab === 'validation' && <ValidationPanel />}
        </div>
      )}
    </div>
  );
}
