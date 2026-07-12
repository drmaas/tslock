import { describe, expect, it } from 'vitest';
import { getDialectInfo } from '../src/dialect-info.js';

describe('getDialectInfo', () => {
  it('postgresql: isDuplicateKeyError for code 23505', () => {
    const info = getDialectInfo('postgresql');
    expect(info.isDuplicateKeyError({ code: '23505' })).toBe(true);
    expect(info.isDuplicateKeyError({ code: '23503' })).toBe(false);
  });

  it('postgresql: translateParams uses $1, $2', () => {
    const info = getDialectInfo('postgresql');
    const { sql, values } = info.translateParams('WHERE n = :name', { name: 'foo' });
    expect(sql).toBe('WHERE n = $1');
    expect(values).toEqual(['foo']);
  });

  it('mysql: isDuplicateKeyError for errno 1062', () => {
    const info = getDialectInfo('mysql');
    expect(info.isDuplicateKeyError({ errno: 1062 })).toBe(true);
    expect(info.isDuplicateKeyError({ errno: 1064 })).toBe(false);
  });

  it('mysql: translateParams uses ?', () => {
    const info = getDialectInfo('mysql');
    const { sql, values } = info.translateParams('WHERE n = :name', { name: 'foo' });
    expect(sql).toBe('WHERE n = ?');
    expect(values).toEqual(['foo']);
  });

  it('sqlite: isDuplicateKeyError for UNIQUE constraint failed', () => {
    const info = getDialectInfo('sqlite');
    expect(info.isDuplicateKeyError(new Error('UNIQUE constraint failed: t.n'))).toBe(true);
    expect(info.isDuplicateKeyError(new Error('other error'))).toBe(false);
  });

  it('sqlite: translateParams uses ?', () => {
    const info = getDialectInfo('sqlite');
    const { sql, values } = info.translateParams('WHERE n = :name', { name: 'foo' });
    expect(sql).toBe('WHERE n = ?');
    expect(values).toEqual(['foo']);
  });

  it('numAffectedRows handles number and bigint', () => {
    const pg = getDialectInfo('postgresql');
    expect(pg.numAffectedRows({ numAffectedRows: 3 })).toBe(3);
    expect(pg.numAffectedRows({ numAffectedRows: 3n })).toBe(3);
    expect(pg.numAffectedRows({})).toBe(0);
    expect(pg.numAffectedRows(null)).toBe(0);
  });
});
