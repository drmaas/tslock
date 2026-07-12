import { afterEach, describe, expect, it } from 'vitest';
import { LockException } from '@tslock/core';
import { DatabaseProduct } from '../src/database-product.js';
import { SqlConfiguration } from '../src/sql-configuration.js';

describe('SqlConfiguration', () => {
  afterEach(() => {
  });

  it('defaults: tableName=shedlock, camelCase columns, hostname', () => {
    const c = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    expect(c.tableName).toBe('shedlock');
    expect(c.columnNames.name).toBe('name');
    expect(c.columnNames.lockUntil).toBe('lockUntil');
    expect(c.lockedByValue.length).toBeGreaterThan(0);
    expect(c.useDbTime).toBe(false);
  });

  it('Oracle uppercases identifiers', () => {
    const c = new SqlConfiguration({ databaseProduct: DatabaseProduct.ORACLE });
    expect(c.tableName).toBe('SHEDLOCK');
    expect(c.columnNames.name).toBe('NAME');
    expect(c.columnNames.lockUntil).toBe('LOCKUNTIL');
  });

  it('DB2 uppercases identifiers', () => {
    const c = new SqlConfiguration({ databaseProduct: DatabaseProduct.DB2 });
    expect(c.tableName).toBe('SHEDLOCK');
  });

  it('HSQL uppercases identifiers', () => {
    const c = new SqlConfiguration({ databaseProduct: DatabaseProduct.HSQL });
    expect(c.tableName).toBe('SHEDLOCK');
  });

  it('throws when both useDbTime and timeZone set', () => {
    expect(
      () =>
        new SqlConfiguration({
          databaseProduct: DatabaseProduct.POSTGRES,
          useDbTime: true,
          timeZone: 'UTC',
        }),
    ).toThrow(LockException);
  });

  it('partial column names merge with defaults', () => {
    const c = new SqlConfiguration({
      databaseProduct: DatabaseProduct.POSTGRES,
      columnNames: { lockedBy: 'owner' },
    });
    expect(c.columnNames.lockedBy).toBe('owner');
    expect(c.columnNames.name).toBe('name');
  });
});
