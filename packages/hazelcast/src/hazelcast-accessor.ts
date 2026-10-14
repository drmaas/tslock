import {
  ClockProvider,
  DelegatingSimpleLock,
  type LockConfiguration,
  lockAtLeastUntil,
  lockAtMostUntil,
  type SimpleLock,
  Utils,
} from '@tslock/core';
import type { Client as HazelcastClient } from 'hazelcast-client';
import type { HazelcastLockRecord } from './hazelcast-lock-record.js';

export class HazelcastAccessor {
  constructor(
    private readonly client: HazelcastClient,
    private readonly lockStoreKey: string,
    private readonly lockLeaseTimeMs: number,
  ) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const lockUntil = lockAtMostUntil(config);
    const keyLockTimeMs = lockUntil - now;
    const store = await this.client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);

    let locked = false;
    try {
      await store.lock(config.name, keyLockTimeMs);
      locked = true;

      const existing = await store.get(config.name);

      const acquired = (record: HazelcastLockRecord): SimpleLock =>
        new DelegatingSimpleLock(config, {
          unlock: () => this.unlock(config, record),
        });

      if (existing === null) {
        const record: HazelcastLockRecord = {
          lockUntil: Utils.toIsoString(lockUntil),
          lockedAt: Utils.toIsoString(now),
          lockedBy: Utils.getHostname(),
        };
        await store.put(config.name, record, config.lockAtMostFor);
        return acquired(record);
      }

      const existingLockUntil = Date.parse(existing.lockUntil);
      if (existingLockUntil <= now) {
        const record: HazelcastLockRecord = {
          lockUntil: Utils.toIsoString(lockUntil),
          lockedAt: Utils.toIsoString(now),
          lockedBy: Utils.getHostname(),
        };
        await store.put(config.name, record, config.lockAtMostFor);
        return acquired(record);
      }

      return undefined;
    } finally {
      if (locked) {
        try {
          await store.unlock(config.name);
        } catch {}
      }
    }
  }

  async unlock(config: LockConfiguration, expected: HazelcastLockRecord): Promise<void> {
    const now = ClockProvider.now();
    const lockAtLeastUntilValue = lockAtLeastUntil(config);
    const store = await this.client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);

    let locked = false;
    try {
      await store.lock(config.name, this.lockLeaseTimeMs);
      locked = true;

      const existing = await store.get(config.name);
      if (!sameAcquisition(existing, expected)) return;

      if (now >= lockAtLeastUntilValue) {
        await store.remove(config.name);
      } else {
        await store.put(
          config.name,
          {
            lockUntil: Utils.toIsoString(lockAtLeastUntilValue),
            lockedAt: expected.lockedAt,
            lockedBy: expected.lockedBy,
          },
          config.lockAtLeastFor,
        );
      }
    } finally {
      if (locked) {
        try {
          await store.unlock(config.name);
        } catch {}
      }
    }
  }
}

function sameAcquisition(existing: HazelcastLockRecord | null | undefined, expected: HazelcastLockRecord): boolean {
  if (existing === null || existing === undefined) return false;
  return (
    existing.lockedBy === expected.lockedBy &&
    existing.lockedAt === expected.lockedAt &&
    existing.lockUntil === expected.lockUntil
  );
}
