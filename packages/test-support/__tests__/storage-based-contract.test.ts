import {
  ClockProvider,
  type LockConfiguration,
  lockAtMostUntil,
  type StorageAccessor,
  StorageBasedLockProvider,
  Utils,
  unlockTime,
} from '@tslock/core';
import { describe } from 'vitest';
import { storageBasedLockProviderIntegrationTests } from '../src/storage-based-integration-tests.js';

interface LockRecord {
  lockUntil: number;
  lockedBy: string;
}

class MapStorageAccessor implements StorageAccessor {
  private readonly records = new Map<string, LockRecord>();
  private readonly lockedBy = Utils.getHostname();

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    if (this.records.has(config.name)) {
      return false;
    }
    this.records.set(config.name, {
      lockUntil: lockAtMostUntil(config),
      lockedBy: this.lockedBy,
    });
    return true;
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const existing = this.records.get(config.name);
    if (!existing) {
      return false;
    }
    if (existing.lockUntil > ClockProvider.now()) {
      return false;
    }
    this.records.set(config.name, {
      lockUntil: lockAtMostUntil(config),
      lockedBy: this.lockedBy,
    });
    return true;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const existing = this.records.get(config.name);
    if (!existing || existing.lockedBy !== this.lockedBy) {
      return;
    }
    existing.lockUntil = unlockTime(config);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const existing = this.records.get(config.name);
    if (!existing || existing.lockedBy !== this.lockedBy || existing.lockUntil <= ClockProvider.now()) {
      return false;
    }
    existing.lockUntil = lockAtMostUntil(config);
    return true;
  }
}

describe('storageBasedLockProviderIntegrationTests contract wiring', () => {
  const accessor = new MapStorageAccessor();
  const getAccessor = async () => accessor;
  const getProvider = async () => new StorageBasedLockProvider(accessor);

  storageBasedLockProviderIntegrationTests(getProvider, {
    timeMode: 'mock',
    getAccessor,
  });
});
