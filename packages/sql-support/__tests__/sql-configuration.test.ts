import { LockException } from '@tslock/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseProduct } from '../src/database-product.js';
import { SqlConfiguration } from '../src/sql-configuration.js';

describe('SqlConfiguration', () => {
  afterEach(() => {});

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

  it('accepts safe custom identifiers', () => {
    const c = new SqlConfiguration({
      databaseProduct: DatabaseProduct.POSTGRES,
      tableName: 'my_locks',
      columnNames: { lockUntil: 'expires_at' },
    });
    expect(c.tableName).toBe('my_locks');
    expect(c.columnNames.lockUntil).toBe('expires_at');
    const underscored = new SqlConfiguration({
      databaseProduct: DatabaseProduct.POSTGRES,
      tableName: '_foo',
    });
    expect(underscored.tableName).toBe('_foo');
  });

  it('throws LockException for unsafe table and column identifiers', () => {
    const badTable = () =>
      new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES, tableName: 'shedlock;drop' });
    expect(badTable).toThrow(LockException);

    const badColumnSpace = () =>
      new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES, columnNames: { name: 'a b' } });
    expect(badColumnSpace).toThrow(LockException);

    const badColumnDigit = () =>
      new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES, columnNames: { name: '1bad' } });
    expect(badColumnDigit).toThrow(LockException);

    const badEmpty = () => new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES, tableName: '' });
    expect(badEmpty).toThrow(LockException);

    const sqlInjection = () =>
      new SqlConfiguration({
        databaseProduct: DatabaseProduct.POSTGRES,
        columnNames: { lockedBy: "lockedBy = 'x' OR 1=1 --" },
      });
    expect(sqlInjection).toThrow(LockException);
  });
});
