import { ClockProvider, createLockConfig } from '@tslock/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseProduct } from '../src/database-product.js';
import { DefaultSqlStatementsSource } from '../src/default-sql-statements-source.js';
import { createSqlStatementsSource } from '../src/factory.js';
import { PostgresSqlStatementsSource } from '../src/postgres-sql-statements-source.js';
import {
  PostgresServerTimeStatementsSource,
  SqliteServerTimeStatementsSource,
} from '../src/server-time-sql-statements-source.js';
import { SqlConfiguration } from '../src/sql-configuration.js';

describe('DefaultSqlStatementsSource', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('produces 4 statements with default config', () => {
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL });
    const src = new DefaultSqlStatementsSource(config);
    expect(src.getInsertStatement()).toContain('INSERT INTO shedlock');
    expect(src.getUpdateStatement()).toContain('UPDATE shedlock');
    expect(src.getExtendStatement()).toContain('UPDATE shedlock');
    expect(src.getUnlockStatement()).toContain('UPDATE shedlock');
  });

  it('uses custom table and column names', () => {
    const config = new SqlConfiguration({
      databaseProduct: DatabaseProduct.MYSQL,
      tableName: 'my_locks',
      columnNames: { lockUntil: 'expires_at' },
    });
    const src = new DefaultSqlStatementsSource(config);
    expect(src.getInsertStatement()).toContain('my_locks');
    expect(src.getInsertStatement()).toContain('expires_at');
  });

  it('params() includes name, lockUntil, now, lockedBy, unlockTime', () => {
    ClockProvider.setClock(() => 1_000_000);
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL });
    const src = new DefaultSqlStatementsSource(config);
    const lc = createLockConfig('test', 10_000, 1_000);
    const params = src.params(lc);
    expect(params.name).toBe('test');
    expect(params.lockUntil).toBeInstanceOf(Date);
    expect(params.now).toBeInstanceOf(Date);
    expect(params.lockedBy.length).toBeGreaterThan(0);
    expect(params.unlockTime).toBeInstanceOf(Date);
  });
});

describe('PostgresSqlStatementsSource', () => {
  it('insert uses ON CONFLICT DO NOTHING', () => {
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    const src = new PostgresSqlStatementsSource(config);
    expect(src.getInsertStatement()).toContain('ON CONFLICT (name) DO NOTHING');
  });
});

describe('createSqlStatementsSource()', () => {
  it('returns Postgres source for POSTGRES', () => {
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    const src = createSqlStatementsSource(config);
    expect(src).toBeInstanceOf(PostgresSqlStatementsSource);
  });

  it('returns Postgres source for COCKROACH_DB', () => {
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.COCKROACH_DB });
    const src = createSqlStatementsSource(config);
    expect(src.getInsertStatement()).toContain('ON CONFLICT');
  });

  it('returns Default for MySQL', () => {
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL });
    const src = createSqlStatementsSource(config);
    expect(src).toBeInstanceOf(DefaultSqlStatementsSource);
  });

  it('returns Postgres server-time for POSTGRES+useDbTime', () => {
    const config = new SqlConfiguration({
      databaseProduct: DatabaseProduct.POSTGRES,
      useDbTime: true,
    });
    const src = createSqlStatementsSource(config);
    expect(src).toBeInstanceOf(PostgresServerTimeStatementsSource);
  });

  it('returns Sqlite server-time for SQLITE+useDbTime', () => {
    const config = new SqlConfiguration({
      databaseProduct: DatabaseProduct.SQLITE,
      useDbTime: true,
    });
    const src = createSqlStatementsSource(config);
    expect(src).toBeInstanceOf(SqliteServerTimeStatementsSource);
  });
});

describe('ServerTimeStatementsSource', () => {
  it('Postgres uses now() expression', () => {
    const config = new SqlConfiguration({
      databaseProduct: DatabaseProduct.POSTGRES,
      useDbTime: true,
    });
    const src = new PostgresServerTimeStatementsSource(config);
    expect(src.getUpdateStatement()).toContain('now()');
    expect(src.getInsertStatement()).toContain('ON CONFLICT');
  });

  it('Sqlite uses strftime expression', () => {
    const config = new SqlConfiguration({
      databaseProduct: DatabaseProduct.SQLITE,
      useDbTime: true,
    });
    const src = new SqliteServerTimeStatementsSource(config);
    expect(src.getInsertStatement()).toContain('INSERT OR IGNORE');
    expect(src.getUpdateStatement()).toContain("strftime('%Y-%m-%dT%H:%M:%fZ'");
  });
});
