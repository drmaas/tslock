import { LockException } from '@tslock/core';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { buildDrizzleQuery } from '../src/query-builder.js';

describe('buildDrizzleQuery', () => {
  it('throws LockException on a missing param', () => {
    expect(() => buildDrizzleQuery('WHERE n = :name', {})).toThrow(LockException);
  });

  it('binds a value for each ? occurrence of a repeated name', () => {
    const query = buildDrizzleQuery(
      'SET locked_at = :now, locked_by = :lockedBy WHERE name = :name AND lock_until <= :now',
      { now: 100, lockedBy: 'host', name: 'job' },
    );
    const expectedSql = 'SET locked_at = ?, locked_by = ? WHERE name = ? AND lock_until <= ?';
    const expectedParams = [100, 'host', 'job', 100];
    for (const dialect of [new MySqlDialect(), new SQLiteSyncDialect()]) {
      const compiled = dialect.sqlToQuery(query);
      expect(compiled.sql).toBe(expectedSql);
      expect(compiled.params).toEqual(expectedParams);
      expect(compiled.params).toHaveLength(compiled.sql.split('?').length - 1);
    }
  });
});
