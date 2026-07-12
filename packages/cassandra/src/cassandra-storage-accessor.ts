import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';
import type cassandra from 'cassandra-driver';
import { buildInsertCql, buildUpdateCql, buildUnlockCql, buildExtendCql } from './cassandra-cql.js';
import type { ResolvedCassandraOptions } from './cassandra-cql.js';

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
    return await this.executeLwt(cql, params);
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
    const result = await this.client.execute(cql, params, {
      prepare: true,
      consistency: this.opts.consistencyLevel,
      serialConsistency: this.opts.serialConsistencyLevel,
    });
    const row = result.rows[0];
    return row?.['[applied]'] === true;
  }
}
