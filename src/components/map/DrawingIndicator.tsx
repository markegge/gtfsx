
import { useStore } from '../../store';

export function DrawingIndicator() {
  const mapMode = useStore((s) => s.mapMode);
  const stopPlacementMode = useStore((s) => s.stopPlacementMode);

  if (mapMode === 'select') return null;

  const messages: Record<string, string> = {
    draw_route: 'Drawing Route Shape — Click to add points, double-click to finish',
    place_stop: `Placing Stops — Click ${stopPlacementMode === 'snap_to_route' ? 'along route' : 'anywhere'} to add a stop`,
    edit_vertices: 'Editing Shape — Drag vertices to adjust',
    edit_shape: 'Editing Shape — Drag vertices, click midpoints to add, Delete key to remove. Click Save when done.',
    draw_flex_zone: 'Drawing Flex Zone — Click to add vertices, double-click to close polygon',
    edit_flex_zone: 'Editing Flex Zone — Drag vertices, click midpoints to add, Delete key to remove',
  };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-coral text-white px-5 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2 z-10">
      <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
      {messages[mapMode]}
    </div>
  );
}
