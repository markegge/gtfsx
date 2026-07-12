// NTD ID validation, shared by every entry point that lets a user type one
// (PublishPanel for signed-in publishing, ExportDialog for the anonymous
// IndexedDB editor). Keeping the rule here means the two can't drift.
//
// NTD IDs are 1–5 digit STRINGS with significant leading zeros ("01234"), so
// this is a string test — never Number()-coerce an NTD ID anywhere.
export const NTD_ID_RE = /^[0-9]{1,5}$/;

/**
 * True when a *set* NTD ID is malformed. An empty/unset value is not invalid —
 * the field is optional everywhere it appears.
 */
export function isNtdIdInvalid(value: string | null | undefined): boolean {
  return !!value && !NTD_ID_RE.test(value);
}

/** The one-line hint shown under a malformed NTD ID input. */
export const NTD_ID_INVALID_HINT =
  "NTD IDs are 1–5 digits. Keep any leading zeros — they're part of the ID.";
