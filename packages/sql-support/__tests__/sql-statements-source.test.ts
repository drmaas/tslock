import { ClockProvider, createLockConfig } from '@tslock/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseProduct } from '../src/database-product.js';
import { DefaultSqlStatementsSource } from '../src/default-sql-statements-source.js';
import { createSqlStatementsSource } from '../src/factory.js';
import { PostgresSqlStatementsSource } from '../src/postgres-sql-statements-source.js';
import {
  Db2ServerTimeStatementsSource,
  H2ServerTimeStatementsSource,
  HsqlServerTimeStatementsSource,
  MsSqlServerTimeStatementsSource,
  MySqlServerTimeStatementsSource,
  OracleServerTimeStatementsSource,
  PostgresServerTimeStatementsSource,
  SqliteServerTimeStatementsSource,
} from '../src/server-time-sql-statements-source.js';
import { SqlConfiguration } from '../src/sql-configuration.js';
import type { SqlStatementsSource } from '../src/sql-statements-source.js';

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
    expect(String(params.lockedBy).length).toBeGreaterThan(0);
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

  it('binds the previous deadline', () => {
    const src = new PostgresServerTimeStatementsSource(
      new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES, useDbTime: true }),
    );
    const params = src.params({ name: 'job', lockAtMostFor: 20_000, lockAtLeastFor: 0, createdAt: 5_000 }, 1_000);
    expect(params.previousLockUntil).toEqual(new Date(1_000));
    expect(params.lockUntil).toEqual(new Date(25_000));
  });
});

describe('acquired deadline predicates', () => {
  const sources = deadlineSources();

  it('unlock requires lockUntil = :lockUntil', () => {
    for (const src of sources) {
      expect(src.getUnlockStatement()).toContain('lockUntil = :lockUntil');
    }
  });

  it('extend requires the previous deadline', () => {
    for (const src of sources) {
      expect(src.getExtendStatement()).toContain('lockUntil = :previousLockUntil');
    }
  });

  it('leaves insert and expired-row update unchanged', () => {
    const mysql = new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL });
    const postgres = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    const server = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES, useDbTime: true });
    expect(new DefaultSqlStatementsSource(mysql).getInsertStatement()).toBe(
      'INSERT INTO shedlock(name, lockUntil, lockedAt, lockedBy) VALUES(:name, :lockUntil, :now, :lockedBy)',
    );
    expect(new DefaultSqlStatementsSource(mysql).getUpdateStatement()).toBe(
      'UPDATE shedlock SET lockUntil = :lockUntil, lockedAt = :now, lockedBy = :lockedBy WHERE name = :name AND lockUntil <= :now',
    );
    expect(new PostgresSqlStatementsSource(postgres).getInsertStatement()).toBe(
      'INSERT INTO shedlock(name, lockUntil, lockedAt, lockedBy) VALUES(:name, :lockUntil, :now, :lockedBy) ON CONFLICT (name) DO NOTHING',
    );
    expect(new PostgresSqlStatementsSource(postgres).getUpdateStatement()).toBe(
      'UPDATE shedlock SET lockUntil = :lockUntil, lockedAt = :now, lockedBy = :lockedBy WHERE name = :name AND lockUntil <= :now',
    );
    expect(new PostgresServerTimeStatementsSource(server).getUpdateStatement()).toBe(
      'UPDATE shedlock SET lockUntil = :lockUntil, lockedAt = now(), lockedBy = :lockedBy WHERE name = :name AND lockUntil <= now()',
    );
    for (const src of sources) {
      expect(src.getInsertStatement()).not.toContain('previousLockUntil');
      expect(src.getUpdateStatement()).not.toContain('previousLockUntil');
    }
  });

  it('uses the configured lockUntil column', () => {
    const custom = new DefaultSqlStatementsSource(
      new SqlConfiguration({
        databaseProduct: DatabaseProduct.MYSQL,
        columnNames: { lockUntil: 'expires_at' },
      }),
    );
    expect(custom.getUnlockStatement()).toContain('expires_at = :lockUntil');
    expect(custom.getExtendStatement()).toContain('expires_at = :previousLockUntil');

    const oracle = new OracleServerTimeStatementsSource(
      new SqlConfiguration({ databaseProduct: DatabaseProduct.ORACLE, useDbTime: true }),
    );
    expect(oracle.getUnlockStatement()).toContain('LOCKUNTIL = :lockUntil');
    expect(oracle.getExtendStatement()).toContain('LOCKUNTIL = :previousLockUntil');
  });
});

function deadlineSources(): SqlStatementsSource[] {
  const camel = (product: DatabaseProduct, useDbTime = false) =>
    new SqlConfiguration({ databaseProduct: product, useDbTime });
  return [
    new DefaultSqlStatementsSource(camel(DatabaseProduct.MYSQL)),
    new PostgresSqlStatementsSource(camel(DatabaseProduct.POSTGRES)),
    new PostgresServerTimeStatementsSource(camel(DatabaseProduct.POSTGRES, true)),
    new MsSqlServerTimeStatementsSource(camel(DatabaseProduct.SQL_SERVER, true)),
    new MySqlServerTimeStatementsSource(camel(DatabaseProduct.MYSQL, true)),
    new OracleServerTimeStatementsSource(camel(DatabaseProduct.MYSQL, true)),
    new HsqlServerTimeStatementsSource(camel(DatabaseProduct.MYSQL, true)),
    new H2ServerTimeStatementsSource(camel(DatabaseProduct.H2, true)),
    new Db2ServerTimeStatementsSource(camel(DatabaseProduct.MYSQL, true)),
    new SqliteServerTimeStatementsSource(camel(DatabaseProduct.SQLITE, true)),
  ];
}
