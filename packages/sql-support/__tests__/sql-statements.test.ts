import { LockException } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import {
  buildPositionalParams,
  prefixNamedParams,
  translateNamedParams,
  translateToPositional,
} from '../src/sql-statements.js';

describe('translateToPositional', () => {
  it('replaces named params with $1, $2, ...', () => {
    const sql = 'INSERT INTO t (a, b) VALUES(:a, :b)';
    const result = translateToPositional(sql, ['a', 'b']);
    expect(result).toBe('INSERT INTO t (a, b) VALUES($1, $2)');
  });

  it('handles repeated params (each occurrence increments)', () => {
    const sql = 'SELECT * WHERE x = :now AND y < :now';
    const result = translateToPositional(sql, ['now']);
    expect(result).toBe('SELECT * WHERE x = $1 AND y < $2');
  });

  it('handles zero params', () => {
    const sql = 'SELECT 1';
    const result = translateToPositional(sql, []);
    expect(result).toBe('SELECT 1');
  });
});

describe('buildPositionalParams', () => {
  it('builds positional array from named params record', () => {
    const params = { a: 1, b: 'two' };
    const result = buildPositionalParams(params, ['a', 'b']);
    expect(result).toEqual([1, 'two']);
  });
});

describe('translateNamedParams', () => {
  it('reuses the index for a repeated name', () => {
    const { sql, values } = translateNamedParams('WHERE x = :now AND y < :now', { now: 100 }, (i) => `$${i}`);
    expect(sql).toBe('WHERE x = $1 AND y < $1');
    expect(values).toEqual([100]);
  });

  it('binds a value for each ? occurrence of a repeated name', () => {
    const { sql, values } = translateNamedParams(
      'SET locked_at = :now, locked_by = :lockedBy WHERE name = :name AND lock_until <= :now',
      { now: 100, lockedBy: 'host', name: 'job' },
      () => '?',
    );
    expect(sql).toBe('SET locked_at = ?, locked_by = ? WHERE name = ? AND lock_until <= ?');
    expect(values).toEqual([100, 'host', 'job', 100]);
    expect(values).toHaveLength(sql.split('?').length - 1);
  });

  it('throws LockException on a missing param', () => {
    expect(() => translateNamedParams('WHERE n = :name', {}, (i) => `$${i}`)).toThrow(LockException);
  });

  it('passes through SQL with no params', () => {
    const { sql, values } = translateNamedParams('SELECT 1', {}, (i) => `$${i}`);
    expect(sql).toBe('SELECT 1');
    expect(values).toEqual([]);
  });
});

describe('prefixNamedParams', () => {
  it('rewrites to @name', () => {
    const params = { name: 'foo', lockedBy: 'host1' };
    const { sql, params: out } = prefixNamedParams('WHERE n=:name AND lb=:lockedBy', params, '@');
    expect(sql).toBe('WHERE n=@name AND lb=@lockedBy');
    expect(out).toBe(params);
  });

  it('throws LockException on a missing param', () => {
    expect(() => prefixNamedParams('WHERE n=:name', {}, '@')).toThrow(LockException);
  });

  it('returns the same params object', () => {
    const params = { name: 'foo' };
    const { params: out } = prefixNamedParams('WHERE n=:name', params, '@');
    expect(out).toBe(params);
  });
});
