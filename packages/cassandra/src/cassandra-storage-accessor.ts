import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  LockException,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';
import type cassandra from 'cassandra-driver';
import type { ResolvedCassandraOptions } from './cassandra-cql.js';
import { buildExtendCql, buildInsertCql, buildUnlockCql, buildUpdateCql } from './cassandra-cql.js';

export class CassandraStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly client: cassandra.Client,
    private readonly opts: ResolvedCassandraOptions,
  ) {
    super();
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const cql = buildInsertCql(this.opts);
    const params: (string | Date)[] = [
      config.name,
      new Date(lockAtMostUntil(config)),
      new Date(ClockProvider.now()),
      this.opts.lockedByValue,
    ];
    return await this.executeLwt(cql, params);
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const cql = buildUpdateCql(this.opts);
    const now = new Date(ClockProvider.now());
    const params: (string | Date)[] = [
      new Date(lockAtMostUntil(config)),
      new Date(ClockProvider.now()),
      this.opts.lockedByValue,
      config.name,
      now,
    ];
    const row = await this.executeRow(cql, params);
    if (row?.['[applied]'] === true) return true;
    if (readLockUntil(row, this.opts.columnNames.lockUntil) != null) return false;
    throw new LockException(`Lock record not found: ${config.name}`);
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const cql = buildUnlockCql(this.opts);
    const params: (string | Date)[] = [
      new Date(unlockTime(config)),
      config.name,
      this.opts.lockedByValue,
      new Date(ClockProvider.now()),
    ];
    await this.executeLwt(cql, params);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const cql = buildExtendCql(this.opts);
    const params: (string | Date)[] = [
      new Date(lockAtMostUntil(config)),
      config.name,
      this.opts.lockedByValue,
      new Date(ClockProvider.now()),
    ];
    return await this.executeLwt(cql, params);
  }

  private async executeLwt(cql: string, params: (string | Date)[]): Promise<boolean> {
    const row = await this.executeRow(cql, params);
    return row?.['[applied]'] === true;
  }

  private async executeRow(cql: string, params: (string | Date)[]): Promise<cassandra.types.Row | undefined> {
    const result = await this.client.execute(cql, params, {
      prepare: true,
      consistency: this.opts.consistencyLevel,
      serialConsistency: this.opts.serialConsistencyLevel,
    });
    return result.rows[0];
  }
}

type LockRow = {
  readonly get?: (columnName: string | number) => unknown;
  readonly [column: string]: unknown;
};

function readLockUntil(row: LockRow | undefined, column: string): unknown {
  if (row == null) return undefined;
  const folded = column.toLowerCase();
  const names = folded === column ? [column] : [column, folded];
  for (const name of names) {
    const value = cell(row, name);
    if (value !== undefined) return value;
  }
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() !== folded) continue;
    const value = cell(row, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function cell(row: LockRow, name: string): unknown {
  if (typeof row.get === 'function') return row.get(name);
  return row[name];
}
