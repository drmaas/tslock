import { ClockProvider, type LockConfiguration, lockAtMostUntil, unlockTime } from '@tslock/core';
import type { SqlConfiguration } from './sql-configuration.js';
import { SQL_PARAM_NAMES } from './sql-statements.js';
import { timestamp } from './timestamp.js';

export abstract class SqlStatementsSource {
  protected readonly config: SqlConfiguration;

  protected constructor(config: SqlConfiguration) {
    this.config = config;
  }

  abstract getInsertStatement(): string;
  abstract getUpdateStatement(): string;
  abstract getExtendStatement(): string;
  abstract getUnlockStatement(): string;

  params(lockConfig: LockConfiguration, previousLockAtMostUntil?: number): Record<string, unknown> {
    const bound: Record<string, unknown> = {
      [SQL_PARAM_NAMES.NAME]: lockConfig.name,
      [SQL_PARAM_NAMES.LOCK_UNTIL]: this.timestampFor(lockAtMostUntil(lockConfig)),
      [SQL_PARAM_NAMES.NOW]: this.timestampFor(ClockProvider.now()),
      [SQL_PARAM_NAMES.LOCKED_BY]: this.config.lockedByValue,
      [SQL_PARAM_NAMES.UNLOCK_TIME]: this.timestampFor(unlockTime(lockConfig)),
    };
    if (previousLockAtMostUntil !== undefined) {
      bound[SQL_PARAM_NAMES.PREVIOUS_LOCK_UNTIL] = this.timestampFor(previousLockAtMostUntil);
    }
    return bound;
  }

  protected timestampFor(epochMillis: number): Date {
    return timestamp(epochMillis, this.config.timeZone);
  }
}
