// Sentinel globals attached to `window` for cross-component coordination
// outside the Zustand store. Keep this list narrow — these are escape
// hatches for the cases where a sidebar component needs to call a method
// owned by the map (or vice versa) without dragging refs through context.

declare global {
  interface Window {
    __mapFlyTo?: (lng: number, lat: number, zoom?: number) => void;
    __mapFitBounds?: (
      bounds: [[number, number], [number, number]],
      opts?: { padding?: number; maxZoom?: number; duration?: number },
    ) => void;
    __shapeEditSave?: () => void;
    __shapeEditDiscard?: () => void;
    __flexZoneEditSave?: () => void;
    __flexZoneEditDiscard?: () => void;
    /** Cancel an in-progress Draw Route, discard any partial line, and return
     *  to select mode. Used by the toolbar's Draw Route toggle. */
    __cancelDrawRoute?: () => void;
    __flexZoneExpand?: string;
    __drawingDirection?: 0 | 1;
    /** Set by the Routes > Shapes tab's Trim button before entering
     *  'trim_shape' map mode. MapView's click handler reads these to know
     *  which shape to mutate and which side to cut from. */
    __trimShapeId?: string;
    __trimShapeSide?: 'start' | 'end';
    /** Read-only Zustand store reference exposed for browser-console debugging. */
    __gtfsStore?: unknown;
    /** Test-only: trigger the in-page integration tests. Optional zipPath
     *  overrides the default fixture URL. Returns the test-result array. */
    __runTests?: (zipPath?: string) => Promise<unknown>;
  }
}

export {};
