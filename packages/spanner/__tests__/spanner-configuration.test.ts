import type { Database } from '@google-cloud/spanner';
import { LockException } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { resolveSpannerConfiguration } from '../src/spanner-configuration.js';

describe('resolveSpannerConfiguration', () => {
  const database = {} as Database;

  it('throws when database is missing', () => {
    expect(() => resolveSpannerConfiguration({ database: undefined as unknown as Database })).toThrow(LockException);
  });

  it('throws on invalid tableName', () => {
    expect(() => resolveSpannerConfiguration({ database, tableName: 'bad;table' })).toThrow(LockException);
  });

  it('throws on invalid column name', () => {
    expect(() => resolveSpannerConfiguration({ database, columnNames: { lockedBy: 'bad name' } })).toThrow(
      'Invalid columnNames.lockedBy',
    );
  });
});
