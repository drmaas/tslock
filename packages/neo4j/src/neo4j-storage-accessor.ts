import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  lockAtMostUntil,
  Utils,
  unlockTime,
} from '@tslock/core';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import {
  buildExtendCypher,
  buildInsertCypher,
  buildUnlockCypher,
  buildUpdateCypher,
  type ResolvedOptions,
} from './neo4j-cypher.js';

function isConstraintViolation(error: unknown, lockName: string): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e?.message) return false;
  return (
    e.code === 'Neo.ClientError.Schema.ConstraintValidationFailed' &&
    e.message.includes('already exists with label') &&
    e.message.includes(lockName)
  );
}

export class Neo4jStorageAccessor extends AbstractStorageAccessor {
  private readonly insertCypher: string;
  private readonly updateCypher: string;
  private readonly unlockCypher: string;
  private readonly extendCypher: string;
  private readonly lockedByValue: string;

  constructor(
    private readonly driver: Driver,
    opts: ResolvedOptions,
    lockedByValue?: string,
    private readonly database?: string,
  ) {
    super();
    this.insertCypher = buildInsertCypher(opts);
    this.updateCypher = buildUpdateCypher(opts);
    this.unlockCypher = buildUnlockCypher(opts);
    this.extendCypher = buildExtendCypher(opts);
    this.lockedByValue = lockedByValue ?? Utils.getHostname();
  }

  private async withSession<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session(this.database !== undefined ? { database: this.database } : undefined);
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    try {
      await this.withSession((tx) =>
        tx.run(this.insertCypher, {
          name: config.name,
          lockUntil: lockAtMostUntil(config),
          lockedAt: ClockProvider.now(),
          lockedBy: this.lockedByValue,
        }),
      );
      return true;
    } catch (error: unknown) {
      if (isConstraintViolation(error, config.name)) {
        return false;
      }
      throw error;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const result = await this.withSession((tx) =>
      tx.run(this.updateCypher, {
        name: config.name,
        now: ClockProvider.now(),
        lockUntil: lockAtMostUntil(config),
        lockedAt: ClockProvider.now(),
        lockedBy: this.lockedByValue,
      }),
    );
    return result.records.length > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    await this.withSession((tx) =>
      tx.run(this.unlockCypher, {
        name: config.name,
        unlockTime: unlockTime(config),
      }),
    );
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const result = await this.withSession((tx) =>
      tx.run(this.extendCypher, {
        name: config.name,
        lockedBy: this.lockedByValue,
        now: ClockProvider.now(),
        lockUntil: lockAtMostUntil(config),
      }),
    );
    return result.records.length > 0;
  }
}
