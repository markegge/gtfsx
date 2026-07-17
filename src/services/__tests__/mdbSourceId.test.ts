import { describe, it, expect } from 'vitest';
import { parseMdbSourceId } from '../mdbSourceId';

describe('parseMdbSourceId (issue #47 MDB import provenance)', () => {
  it('parses the canonical mdb-<n> Mobility Database id', () => {
    expect(parseMdbSourceId('mdb-1749')).toBe(1749);
    expect(parseMdbSourceId('MDB-42')).toBe(42); // case-insensitive prefix
  });

  it('accepts a bare numeric id (deep-link callers pass either form)', () => {
    expect(parseMdbSourceId('1749')).toBe(1749);
    expect(parseMdbSourceId('  88  ')).toBe(88); // tolerates surrounding whitespace
  });

  it('rejects anything that is not a clean MDB source id (never guesses)', () => {
    expect(parseMdbSourceId(null)).toBeNull();
    expect(parseMdbSourceId(undefined)).toBeNull();
    expect(parseMdbSourceId('')).toBeNull();
    expect(parseMdbSourceId('mdb-')).toBeNull();
    expect(parseMdbSourceId('mdb-12a')).toBeNull();
    expect(parseMdbSourceId('tld-r-9q9-caltrain')).toBeNull(); // transit.land onestop_id
    expect(parseMdbSourceId('mdb-0')).toBeNull(); // 0 is not a real source id
    expect(parseMdbSourceId('12.5')).toBeNull();
  });
});
