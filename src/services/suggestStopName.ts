/** Suggest a stop name from coordinates using Mapbox Tilequery against the
 * streets tileset. Picks the two nearest distinct named roads and formats
 * "Street A and Street B" (a typical transit stop name). Falls back to a
 * single street name if only one is nearby, or null if we can't suggest
 * anything (no token, network error, no named roads within ~30m).
 *
 * Why tilequery (not reverse geocoding): Mapbox's reverse geocoding returns
 * the nearest address, not an intersection. Tilequery on the road layer lets
 * us find every named street near a point and pick the two closest. */
export async function suggestStopName(
  lng: number,
  lat: number,
): Promise<string | null> {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  if (!token) return null;

  // mapbox-streets-v8 is Mapbox's current standard streets tileset; the `road`
  // source-layer holds line features for named roads.
  const url =
    `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json` +
    `?radius=30&limit=20&geometry=linestring&layers=road&access_token=${token}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: Array<{ properties?: { name?: string; class?: string } }>;
    };

    // Tilequery returns features ordered by proximity. Walk them and collect
    // up to two distinct named streets, skipping unnamed segments and trivial
    // duplicates that just describe the same road as multiple tile features.
    const picked: string[] = [];
    const seen = new Set<string>();
    for (const f of data.features ?? []) {
      const name = f.properties?.name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(name);
      if (picked.length >= 2) break;
    }

    if (picked.length >= 2) return `${picked[0]} and ${picked[1]}`;
    if (picked.length === 1) return picked[0];
    return null;
  } catch {
    return null;
  }
}
