import { useState } from 'react';
import { useStore } from '../../store';
import { exportGtfsZip, downloadBlob } from '../../services/gtfsExport';
import { runValidation } from '../../services/validation';
import { Badge } from '../ui/Badge';

interface ExportDialogProps {
  onClose: () => void;
}

export function ExportDialog({ onClose }: ExportDialogProps) {
  const [exporting, setExporting] = useState(false);
  const state = useStore();

  const messages = runValidation(state);
  const errors = messages.filter((m) => m.severity === 'error');
  const warnings = messages.filter((m) => m.severity === 'warning');
  const hasErrors = errors.length > 0;

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportGtfsZip();
      const name = state.projectName.replace(/\s+/g, '_').toLowerCase();
      downloadBlob(blob, `${name}.zip`);
      onClose();
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">Export GTFS Feed</h3>
        <p className="text-xs text-warm-gray mb-4">Your feed will be exported as a ZIP file</p>

        {/* Validation summary */}
        <div className="flex gap-2 mb-4">
          {errors.length > 0 && <Badge variant="error">{errors.length} Errors</Badge>}
          {warnings.length > 0 && <Badge variant="warning">{warnings.length} Warnings</Badge>}
          {errors.length === 0 && warnings.length === 0 && <Badge variant="success">All checks passed</Badge>}
        </div>

        {hasErrors && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
            <p className="font-semibold text-sm text-red-700 mb-1">Fix errors before exporting</p>
            {errors.slice(0, 3).map((e) => (
              <p key={e.id} className="text-xs text-red-600">• {e.message}</p>
            ))}
            {errors.length > 3 && <p className="text-xs text-red-400">...and {errors.length - 3} more</p>}
          </div>
        )}

        {/* File summary */}
        <div className="flex flex-col gap-1 mb-4 text-sm">
          {[
            ['agency.txt', state.agencies.length > 0],
            ['routes.txt', state.routes.length > 0, `${state.routes.length} routes`],
            ['stops.txt', state.stops.length > 0, `${state.stops.length} stops`],
            ['trips.txt', state.trips.length > 0, `${state.trips.length} trips`],
            ['stop_times.txt', state.stopTimes.length > 0],
            ['calendar.txt', state.calendars.length > 0],
            ['shapes.txt', state.shapes.length > 0],
            ['calendar_dates.txt', state.calendarDates.length > 0],
            ['feed_info.txt', !!state.feedInfo],
          ].filter(([, hasData]) => hasData).map(([name, , detail]) => (
            <div key={name as string} className="flex items-center gap-2 px-3 py-1.5 bg-cream rounded">
              <span className="text-teal">✓</span>
              <span>{name}</span>
              {detail && <span className="ml-auto text-warm-gray text-xs">{detail}</span>}
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={hasErrors || exporting}
            className="flex-1 px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm
              hover:bg-[#d4603a] transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
