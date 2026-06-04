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
    /** When set, the next polygon drawn in 'draw_flex_zone' mode is appended to
     *  this existing flex zone (making it a mixed polygon + group zone) instead
     *  of creating a new zone. Cleared by MapView after the draw completes. */
    __flexAddPolygonZoneId?: string;
    __drawingDirection?: 0 | 1;
    /** Target zone_id for the Fares > Fare-zone lasso. Set by FareZoneTool
     *  before entering 'draw_fare_zone' mode; read by MapView's draw-complete
     *  handler to stamp this zone_id onto every stop inside the drawn polygon. */
    __lassoFareZoneId?: string;
    /** Set by FareZoneTool so MapView can report back how many stops the lasso
     *  assigned (for the panel's confirmation message). */
    __onFareZoneAssigned?: (count: number, zoneId: string) => void;
    /** Set by the Routes > Shapes tab's Trim button before entering
     *  'trim_shape' map mode. MapView's click handler reads these to know
     *  which shape to mutate and which side to cut from. */
    __trimShapeId?: string;
    __trimShapeSide?: 'start' | 'end';
    /** One-shot flag set by RoutePopup before its Edit Shape handoff so
     *  useFocusRouteOnMap doesn't auto-fit to the entire route — the user
     *  was already zoomed into the segment they want to edit. Cleared by
     *  the first effect that reads it. Lives on window rather than the
     *  store because store-based signals race with the effect order
     *  between RouteShapesTab (which clears them) and RouteDetailPanel
     *  (which reads them). */
    __suppressNextRouteFit?: boolean;
    /** Read-only Zustand store reference exposed for browser-console debugging. */
    __gtfsStore?: unknown;
    /** Test-only: trigger the in-page integration tests. Optional zipPath
     *  overrides the default fixture URL. Returns the test-result array. */
    __runTests?: (zipPath?: string) => Promise<unknown>;
  }
}

export {};
