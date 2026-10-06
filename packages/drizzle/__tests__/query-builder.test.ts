import { LockException } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { buildDrizzleQuery } from '../src/query-builder.js';

describe('buildDrizzleQuery', () => {
  it('throws LockException on a missing param', () => {
    expect(() => buildDrizzleQuery('WHERE n = :name', {})).toThrow(LockException);
  });
});
