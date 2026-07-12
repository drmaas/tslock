import { describe, expect, it } from 'vitest';
import { LockException } from '@tslock/core';
import { translateToNamed, translateToPositional } from '../src/param-translator.js';

describe('translateToPositional', () => {
  it('replaces :name with $N, collects values in order', () => {
    const { sql, values } = translateToPositional(
      'INSERT INTO t(n, l) VALUES(:name, :lockUntil)',
      { name: 'foo', lockUntil: 1234 },
      (i) => `$${i}`,
    );
    expect(sql).toBe('INSERT INTO t(n, l) VALUES($1, $2)');
    expect(values).toEqual(['foo', 1234]);
  });

  it('reuses same index for repeated :name', () => {
    const { sql, values } = translateToPositional(
      'WHERE x = :now AND y < :now',
      { now: 100 },
      (i) => `$${i}`,
    );
    expect(sql).toBe('WHERE x = $1 AND y < $1');
    expect(values).toEqual([100]);
  });

  it('handles :name with no params in SQL', () => {
    const { sql, values } = translateToPositional('SELECT 1', {}, (i) => `$${i}`);
    expect(sql).toBe('SELECT 1');
    expect(values).toEqual([]);
  });

  it('throws on missing param', () => {
    expect(() =>
      translateToPositional('WHERE n = :name', {}, (i) => `$${i}`),
    ).toThrow(LockException);
  });
});

describe('translateToNamed', () => {
  it('replaces :name with @name', () => {
    const { sql, params } = translateToNamed(
      'WHERE n=:name AND lb=:lockedBy',
      { name: 'foo', lockedBy: 'host1' },
      '@',
    );
    expect(sql).toBe('WHERE n=@name AND lb=@lockedBy');
    expect(params).toEqual({ name: 'foo', lockedBy: 'host1' });
  });

  it('throws on missing param', () => {
    expect(() =>
      translateToNamed('WHERE n=:name', {}, '@'),
    ).toThrow(LockException);
  });
});
