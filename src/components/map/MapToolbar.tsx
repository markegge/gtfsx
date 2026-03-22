
import { useStore } from '../../store';
import type { MapMode } from '../../types/ui';

const TOOLS: { mode: MapMode; icon: string; title: string }[] = [
  { mode: 'select', icon: '☞', title: 'Select' },
  { mode: 'draw_route', icon: '✎', title: 'Draw Route' },
  { mode: 'place_stop', icon: '●', title: 'Add Stop' },
];

export function MapToolbar() {
  const { mapMode, setMapMode } = useStore();

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1 bg-white rounded-xl shadow-md p-1.5 z-10">
      {TOOLS.map(({ mode, icon, title }) => (
        <button
          key={mode}
          title={title}
          onClick={() => setMapMode(mode)}
          className={`w-9 h-9 rounded-lg flex items-center justify-center text-base transition-colors
            ${mapMode === mode
              ? 'bg-coral-light text-coral'
              : 'text-brown hover:bg-cream'
            }`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
