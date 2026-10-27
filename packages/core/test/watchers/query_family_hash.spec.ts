import { describe, expect, it } from 'vitest';
import { queryFamilyHash } from '../../src/watchers/query_family_hash.js';

describe('queryFamilyHash', () => {
  it('returns the same hash on a repeat call (cached) as on the first', () => {
    const sql = `select * from "users" where "id" = 42 and "name" = 'ana'`;
    const first = queryFamilyHash(sql);
    expect(queryFamilyHash(sql)).toBe(first);
    expect(queryFamilyHash(`SELECT *   from "users" where "id" = 7 and "name" = 'bia'`)).toBe(
      first,
    );
  });

  it('keeps normalize: false separate from the normalized cache', () => {
    const sql = 'select 1';
    const normalized = queryFamilyHash(sql);
    expect(queryFamilyHash(sql, false)).not.toBe(normalized);
    expect(queryFamilyHash('select 2', false)).not.toBe(queryFamilyHash(sql, false));
    expect(queryFamilyHash(sql)).toBe(normalized);
  });

  it('stays correct past the cache bound and for very long statements', () => {
    const reference = queryFamilyHash('select * from t where a = 1');
    for (let i = 0; i < 2_500; i++) queryFamilyHash(`select * from t${i} where a = 1`);
    expect(queryFamilyHash('select * from t where a = 999')).toBe(reference);

    const long = `select ${'"c", '.repeat(2_000)}"d" from t where id = 5`;
    expect(queryFamilyHash(long)).toBe(queryFamilyHash(long.replace('= 5', '= 6')));
  });
});
