export const ROUTE_COLORS = [
  '274BAC', '00AEEF', 'BB29BB', 'DFBC00', '5F3B00', 'F289BD', '1DD719', 'E8734A',
  'D32F2F', 'FF9800', '4CAF50', '2196F3', '9C27B0', '795548', '607D8B', '333333',
];

export function getContrastTextColor(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '000000' : 'FFFFFF';
}

/**
 * Return a CSS hex color (#RRGGBB) suitable for drawing direction arrows on the
 * light-v11 map background.  For low-luminance (dark) route colors the original
 * color is returned as-is; high-luminance (light/bright) colors are darkened so
 * the arrow is clearly legible and unmistakably in the route's own color family
 * rather than washing out and being confused with nearby darker-route arrows.
 *
 * Threshold: luminance > 0.40 triggers darkening (covers Gold #DFBC00 = 0.69,
 * NE-Shuttle green #1DD719 = 0.54, cyan #00AEEF = 0.51, pink #F289BD = 0.68,
 * orange #E8734A = 0.57 — all colors that are pale on the white map at 60% opacity).
 *
 * @param hex  6-char hex WITHOUT leading '#' (matches route_color storage)
 * @returns    7-char '#RRGGBB' string ready for Mapbox GL text-color
 */
export function getArrowColor(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (luminance <= 0.40) {
    return `#${hex}`;
  }
  // Darken to ~55 % brightness — keeps the hue clearly recognisable while
  // giving enough contrast against the white map background.
  const factor = 0.55;
  const dr = Math.floor(r * factor).toString(16).padStart(2, '0');
  const dg = Math.floor(g * factor).toString(16).padStart(2, '0');
  const db = Math.floor(b * factor).toString(16).padStart(2, '0');
  return `#${dr}${dg}${db}`;
}
