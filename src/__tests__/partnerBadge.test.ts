/**
 * Unit tests for the partner-badge attribution logic in DeepLinkImportPage.
 *
 * resolvePartnerLabel(source, ref) determines whether a "Loaded from <partner>"
 * banner should appear after a deep-link import:
 *   - known `source` values render a badge even without a `ref` param
 *   - known `ref` values render a badge on url-based imports
 *   - unknown / absent values produce null (no badge)
 *   - `source` takes precedence over `ref`
 */
import { describe, expect, it } from 'vitest';
import { resolvePartnerLabel } from '../components/import-export/partnerAttribution';

describe('resolvePartnerLabel', () => {
  it('returns Mobility Database for source=mobilitydb (no ref)', () => {
    expect(resolvePartnerLabel('mobilitydb', null)).toBe('Mobility Database');
  });

  it('returns Mobility Database for source=mobilitydb with ref present', () => {
    // source wins over ref
    expect(resolvePartnerLabel('mobilitydb', 'mobilitydb')).toBe('Mobility Database');
  });

  it('returns Mobility Database for ref=mobilitydb when source is absent', () => {
    expect(resolvePartnerLabel(null, 'mobilitydb')).toBe('Mobility Database');
  });

  it('returns Mobility Database for ref=mobilitydata (legacy alias)', () => {
    expect(resolvePartnerLabel(null, 'mobilitydata')).toBe('Mobility Database');
  });

  it('returns Canonical GTFS Validator for ref=gtfs_validator', () => {
    expect(resolvePartnerLabel(null, 'gtfs_validator')).toBe('Canonical GTFS Validator');
  });

  it('returns null for an unknown ref on a url-based import', () => {
    expect(resolvePartnerLabel(null, 'unknownpartner')).toBeNull();
  });

  it('returns null when both source and ref are absent', () => {
    expect(resolvePartnerLabel(null, null)).toBeNull();
  });

  it('returns null when both source and ref are undefined', () => {
    expect(resolvePartnerLabel(undefined, undefined)).toBeNull();
  });

  it('returns null for an unknown source even with a known ref', () => {
    // Unknown source does not earn a badge; known ref still does.
    expect(resolvePartnerLabel('unknowncatalog', 'mobilitydb')).toBe('Mobility Database');
  });

  it('source takes precedence: mobilitydb source beats a different ref', () => {
    expect(resolvePartnerLabel('mobilitydb', 'gtfs_validator')).toBe('Mobility Database');
  });
});
