import { useState } from 'react';

export type MapStyleId = 'light' | 'satellite';

interface MapLayerControlsProps {
  mapStyle: MapStyleId;
  onMapStyleChange: (style: MapStyleId) => void;
  showDemandDots: boolean;
  onShowDemandDotsChange: (show: boolean) => void;
}

export function MapLayerControls({
  mapStyle,
  onMapStyleChange,
  showDemandDots,
  onShowDemandDotsChange,
}: MapLayerControlsProps) {
  const [open, setOpen] = useState(false);
  // Demand dots (propensity map) are free for everyone, incl. anonymous — no gate.

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
        <div className="mt-1.5 bg-white rounded-xl shadow-lg p-3 w-[240px]">
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

          {/* Demand dots */}
          <div className="text-[10px] font-bold text-warm-gray uppercase tracking-wider mb-1.5">
            Transit Demand
          </div>
          <label className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-semibold cursor-pointer hover:bg-cream transition-colors">
            <input
              type="checkbox"
              checked={showDemandDots}
              onChange={(e) => onShowDemandDotsChange(e.target.checked)}
              className="accent-coral"
            />
            <span className="text-dark-brown">Demand Dots</span>
          </label>
          {showDemandDots && (
            <div className="flex flex-col gap-0.5 mt-1 px-2">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="w-2 h-2 rounded-full" style={{ background: '#2563eb' }} />
                <span className="text-warm-gray">High transit propensity</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="w-2 h-2 rounded-full" style={{ background: '#9ca3af' }} />
                <span className="text-warm-gray">Other adults</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="w-2 h-2 rounded-full" style={{ background: '#f97316' }} />
                <span className="text-warm-gray">Jobs</span>
              </div>
              <p className="text-[9px] text-warm-gray/70 mt-1 leading-snug">
                1 dot = 5 people or jobs. High propensity = renters, zero-vehicle HH, or age 18–24 (deduplicated). Based on ACS 2020–2024 5-yr + LEHD LODES 8 (2023) + 2020 Census blocks (TIGER 2025). Nationwide coverage; AK and PR show population only (no LODES published).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
