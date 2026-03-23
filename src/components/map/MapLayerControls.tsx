import { useState } from 'react';
import { useStore } from '../../store';

export type MapStyleId = 'light' | 'satellite';
export type HeatmapMetric = 'off' | 'population' | 'workers' | 'households';

interface MapLayerControlsProps {
  mapStyle: MapStyleId;
  onMapStyleChange: (style: MapStyleId) => void;
  heatmapMetric: HeatmapMetric;
  onHeatmapMetricChange: (metric: HeatmapMetric) => void;
}

export function MapLayerControls({
  mapStyle,
  onMapStyleChange,
  heatmapMetric,
  onHeatmapMetricChange,
}: MapLayerControlsProps) {
  const [open, setOpen] = useState(false);
  const coverageData = useStore((s) => s.coverageData);
  const hasCensusData = !!coverageData?.blockGroups?.length;

  return (
    <div className="absolute top-3 left-3 z-10">
      <button
        onClick={() => setOpen(!open)}
        className={`w-9 h-9 rounded-lg flex items-center justify-center shadow-md transition-colors text-sm
          ${open ? 'bg-coral text-white' : 'bg-white text-brown hover:bg-cream'}`}
        title="Map layers"
      >
        ◫
      </button>

      {open && (
        <div className="mt-1.5 bg-white rounded-xl shadow-lg p-3 min-w-[180px]">
          {/* Base map style */}
          <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
            Base Map
          </div>
          <div className="flex gap-1.5 mb-3">
            <button
              onClick={() => onMapStyleChange('light')}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors
                ${mapStyle === 'light' ? 'bg-coral-light text-coral' : 'bg-cream text-warm-gray hover:bg-sand'}`}
            >
              Streets
            </button>
            <button
              onClick={() => onMapStyleChange('satellite')}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors
                ${mapStyle === 'satellite' ? 'bg-coral-light text-coral' : 'bg-cream text-warm-gray hover:bg-sand'}`}
            >
              Satellite
            </button>
          </div>

          {/* Density heatmap */}
          <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
            Density Heatmap
          </div>
          {hasCensusData ? (
            <div className="flex flex-col gap-1">
              {([
                ['off', 'Off'],
                ['population', 'Population'],
                ['workers', 'Workers'],
                ['households', 'Households'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => onHeatmapMetricChange(key)}
                  className={`px-2 py-1.5 rounded-md text-[11px] font-semibold text-left transition-colors
                    ${heatmapMetric === key ? 'bg-coral-light text-coral' : 'bg-cream text-warm-gray hover:bg-sand'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-warm-gray">
              Run <strong className="text-dark-brown">Coverage Analysis</strong> first to load census data for the heatmap.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
