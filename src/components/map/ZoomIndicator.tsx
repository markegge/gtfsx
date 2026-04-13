import { useEffect, useState } from 'react';
import { useMap } from 'react-map-gl/mapbox';

export function ZoomIndicator() {
  const { current: mapRef } = useMap();
  const [zoom, setZoom] = useState<number | null>(() => mapRef?.getZoom() ?? null);

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    const update = () => setZoom(map.getZoom());
    update();
    map.on('zoom', update);
    return () => {
      map.off('zoom', update);
    };
  }, [mapRef]);

  if (zoom == null) return null;
  return (
    <div className="absolute bottom-3 left-3 z-10 bg-white/90 backdrop-blur rounded-md px-2 py-1 shadow text-[11px] font-mono text-dark-brown tabular-nums">
      z {zoom.toFixed(1)}
    </div>
  );
}
