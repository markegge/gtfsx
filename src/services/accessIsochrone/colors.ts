// Colors for the access-isochrone rings. Single hue (blue), stepped saturation —
// the standard travel-time-isochrone convention (closest reach = darkest /
// most saturated; longer budgets get lighter). Shared by the panel legend, the
// map outlines, and the on-map time labels so they always agree. Index by the
// ring's position in the ascending budget list.
export const ACCESS_RING_COLORS = ['#0b4f9c', '#2f7fce', '#69a8e3', '#a8cdf1'] as const;

/** Per-ring outline / legend / label color (darkest = shortest budget). */
export function accessRingColor(index: number): string {
  return ACCESS_RING_COLORS[index % ACCESS_RING_COLORS.length];
}

/** Single uniform fill hue. The nested rings are drawn translucent and stacked
 *  (largest underneath), so the reachable area naturally deepens toward the
 *  origin — one hue, increasing saturation toward the center. */
export const ACCESS_FILL_COLOR = '#2f7fce';
