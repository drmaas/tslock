import type { Client } from '@opensearch-project/opensearch';
import { ClockProvider, type LockConfiguration, lockAtMostUntil, Utils, unlockTime } from '@tslock/core';
import { EXTEND_SCRIPT, isConflictError, isNotFoundError, LOCK_SCRIPT, UNLOCK_SCRIPT } from '@tslock/search-core';
import type { OpenSearchFieldNames } from './field-names.js';
import { OpenSearchLock } from './opensearch-lock.js';

export class OpenSearchAccessor {
  constructor(
    private readonly client: Client,
    private readonly index: string,
    private readonly fieldNames: OpenSearchFieldNames,
  ) {}

  async lock(config: LockConfiguration): Promise<OpenSearchLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const isoNow = Utils.toIsoString(now);
    const isoLockUntil = Utils.toIsoString(lockAtMostUntil(config));

    try {
      const response = await this.client.update({
        id: config.name,
        index: this.index,
        refresh: 'wait_for',
        body: {
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
        },
      });

      if (response.body.result === 'noop') return undefined;
      return new OpenSearchLock(config, this);
    } catch (e) {
      if (isConflictError(e)) return undefined;
      throw e;
    }
  }

  async extend(config: LockConfiguration): Promise<OpenSearchLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const isoNow = Utils.toIsoString(now);
    const isoNewLockUntil = Utils.toIsoString(lockAtMostUntil(config));

    try {
      const response = await this.client.update({
        id: config.name,
        index: this.index,
        refresh: 'wait_for',
        body: {
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
        },
      });

      if (response.body.result === 'noop') return undefined;
      return new OpenSearchLock(config, this);
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
        body: {
          script: {
            source: UNLOCK_SCRIPT,
            params: {
              unlockTime: isoUnlock,
              lockUntilField: this.fieldNames.lockUntil,
            },
          },
        },
      });
    } catch (e) {
      if (isNotFoundError(e)) return;
      throw e;
    }
  }
}
