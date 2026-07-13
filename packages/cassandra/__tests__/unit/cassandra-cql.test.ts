import { describe, expect, it } from 'vitest';
import type { ResolvedColumnNames } from '../../src/cassandra-cql.js';
import {
  buildCreateTableCql,
  buildExtendCql,
  buildInsertCql,
  buildUnlockCql,
  buildUpdateCql,
} from '../../src/cassandra-cql.js';

const defaultCols: ResolvedColumnNames = {
  name: 'name',
  lockUntil: 'lock_until',
  lockedAt: 'locked_at',
  lockedBy: 'locked_by',
};

const customCols: ResolvedColumnNames = {
  name: 'lock_name',
  lockUntil: 'expires_at',
  lockedAt: 'created_at',
  lockedBy: 'owner',
};

describe('CQL builders', () => {
  it('buildInsertCql with default options', () => {
    const cql = buildInsertCql({ keyspace: 'shedlock', tableName: 'shedlock', columnNames: defaultCols });
    expect(cql).toBe(
      'INSERT INTO shedlock.shedlock (name, lock_until, locked_at, locked_by) VALUES (?, ?, ?, ?) IF NOT EXISTS',
    );
  });

  it('buildInsertCql with custom column names', () => {
    const cql = buildInsertCql({ keyspace: 'ks', tableName: 'tbl', columnNames: customCols });
    expect(cql).toBe('INSERT INTO ks.tbl (lock_name, expires_at, created_at, owner) VALUES (?, ?, ?, ?) IF NOT EXISTS');
  });

  it('buildUpdateCql with default options', () => {
    const cql = buildUpdateCql({ keyspace: 'shedlock', tableName: 'shedlock', columnNames: defaultCols });
    expect(cql).toBe(
      'UPDATE shedlock.shedlock SET lock_until = ?, locked_at = ?, locked_by = ? WHERE name = ? IF lock_until < ?',
    );
  });

  it('buildUnlockCql with default options', () => {
    const cql = buildUnlockCql({ keyspace: 'shedlock', tableName: 'shedlock', columnNames: defaultCols });
    expect(cql).toBe('UPDATE shedlock.shedlock SET lock_until = ? WHERE name = ? IF locked_by = ? AND lock_until >= ?');
  });

  it('buildExtendCql produces same shape as buildUnlockCql', () => {
    const cql1 = buildUnlockCql({ keyspace: 'ks', tableName: 'tbl', columnNames: defaultCols });
    const cql2 = buildExtendCql({ keyspace: 'ks', tableName: 'tbl', columnNames: defaultCols });
    expect(cql1).toBe(cql2);
  });

  it('buildCreateTableCql with default options', () => {
    const cql = buildCreateTableCql({ keyspace: 'shedlock', tableName: 'shedlock', columnNames: defaultCols });
    expect(cql).toBe(
      'CREATE TABLE IF NOT EXISTS shedlock.shedlock (name text PRIMARY KEY, lock_until timestamp, locked_at timestamp, locked_by text)',
    );
  });

  it('buildCreateTableCql with custom column names', () => {
    const cql = buildCreateTableCql({ keyspace: 'ks', tableName: 'tbl', columnNames: customCols });
    expect(cql).toBe(
      'CREATE TABLE IF NOT EXISTS ks.tbl (lock_name text PRIMARY KEY, expires_at timestamp, created_at timestamp, owner text)',
    );
  });
});
