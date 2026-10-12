import {
  ClockProvider,
  DelegatingSimpleLock,
  type LockConfiguration,
  lockAtMostUntil,
  type SimpleLock,
  Utils,
  unlockTime,
} from '@tslock/core';
import type { SearchFieldNames } from './field-names.js';
import { isConflictError, isNotFoundError } from './http-status-errors.js';
import { EXTEND_SCRIPT, LOCK_SCRIPT, UNLOCK_SCRIPT } from './scripts.js';
import type { SearchUpdateClient } from './search-update-client.js';

export class SearchLockAccessor {
  constructor(
    private readonly client: SearchUpdateClient,
    private readonly index: string,
    private readonly fieldNames: SearchFieldNames,
  ) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const isoNow = Utils.toIsoString(now);
    const isoLockUntil = Utils.toIsoString(lockAtMostUntil(config));

    try {
      const response = await this.client.update({
        id: config.name,
        index: this.index,
        refresh: 'wait_for',
        script: {
          source: LOCK_SCRIPT,
          params: {
            now: isoNow,
            lockUntil: isoLockUntil,
            lockedAt: isoNow,
            lockedBy: hostname,
            lockUntilField: this.fieldNames.lockUntil,
            lockedAtField: this.fieldNames.lockedAt,
            lockedByField: this.fieldNames.lockedBy,
          },
        },
        upsert: {
          [this.fieldNames.lockUntil]: isoLockUntil,
          [this.fieldNames.lockedAt]: isoNow,
          [this.fieldNames.lockedBy]: hostname,
        },
      });

      if (response.result === 'noop') return undefined;
      return new DelegatingSimpleLock(config, this);
    } catch (e) {
      if (isConflictError(e)) return undefined;
      throw e;
    }
  }

  async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const isoNow = Utils.toIsoString(now);
    const isoNewLockUntil = Utils.toIsoString(lockAtMostUntil(config));

    try {
      const response = await this.client.update({
        id: config.name,
        index: this.index,
        refresh: 'wait_for',
        script: {
          source: EXTEND_SCRIPT,
          params: {
            now: isoNow,
            lockUntil: isoNewLockUntil,
            lockedBy: hostname,
            lockUntilField: this.fieldNames.lockUntil,
            lockedByField: this.fieldNames.lockedBy,
          },
        },
      });

      if (response.result === 'noop') return undefined;
      return new DelegatingSimpleLock(config, this);
    } catch (e) {
      if (isConflictError(e)) return undefined;
      if (isNotFoundError(e)) return undefined;
      throw e;
    }
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const isoUnlock = Utils.toIsoString(unlockTime(config));

    try {
      await this.client.update({
        id: config.name,
        index: this.index,
        refresh: 'wait_for',
        script: {
          source: UNLOCK_SCRIPT,
          params: {
            unlockTime: isoUnlock,
            lockUntilField: this.fieldNames.lockUntil,
          },
        },
      });
    } catch (e) {
      if (isNotFoundError(e)) return;
      throw e;
    }
  }
}
