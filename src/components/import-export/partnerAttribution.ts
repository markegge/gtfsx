// Partner attribution for deep-link imports (kept outside the page component
// so component files only export components — react-refresh/only-export-components).

// Known catalog source values that automatically render an attribution badge,
// even when no `ref` param is present. Keyed by the `source` query param value.
const SOURCE_LABELS: Record<string, string> = {
  mobilitydb: 'Mobility Database',
  transitland: 'Transitland',
};

// Known partner ref values that render an attribution badge when used on
// url-based imports (or when source is unknown). Keyed by the `ref` param value.
const PARTNER_LABELS: Record<string, string> = {
  mobilitydb: 'Mobility Database',
  mobilitydata: 'Mobility Database',
  transitland: 'Transitland',
  gtfs_validator: 'Canonical GTFS Validator',
};

/**
 * Resolve a human-readable partner label for the "Loaded from …" banner.
 * `source` takes precedence over `ref` — catalog-source imports are always
 * attributed to the catalog even when no `ref` is passed.
 *
 * Returns null when neither maps to a known partner (keeps arbitrary values off
 * the UI).
 */
export function resolvePartnerLabel(
  source: string | null | undefined,
  ref: string | null | undefined,
): string | null {
  if (source && SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (ref && PARTNER_LABELS[ref]) return PARTNER_LABELS[ref];
  return null;
}
