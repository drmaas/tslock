import { describe, expect, it } from 'vitest';
import { translateToPositional, buildPositionalParams } from '../src/sql-statements.js';

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
