import { ClockProvider, Utils, type LockConfiguration, lockAtMostUntil, lockAtLeastUntil } from '@tslock/core';
import type { Client as HazelcastClient } from 'hazelcast-client';
import type { HazelcastLockRecord } from './hazelcast-lock-record.js';
import { HazelcastLock } from './hazelcast-lock.js';

export class HazelcastAccessor {
  constructor(
    private readonly client: HazelcastClient,
    private readonly lockStoreKey: string,
    private readonly lockLeaseTimeMs: number,
  ) {}

  async lock(config: LockConfiguration): Promise<HazelcastLock | undefined> {
    const now = ClockProvider.now();
    const lockUntil = lockAtMostUntil(config);
    const keyLockTimeMs = lockUntil - now;
    const store = await this.client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);

    let locked = false;
    try {
      await store.lock(config.name, keyLockTimeMs);
      locked = true;

      const existing = await store.get(config.name);

      if (existing === null) {
        await store.put(
          config.name,
          {
            lockUntil: Utils.toIsoString(lockUntil),
            lockedAt: Utils.toIsoString(now),
            lockedBy: Utils.getHostname(),
          },
          config.lockAtMostFor,
        );
        return new HazelcastLock(config, this);
      }

      const existingLockUntil = Date.parse(existing.lockUntil);
      if (existingLockUntil <= now) {
        await store.put(
          config.name,
          {
            lockUntil: Utils.toIsoString(lockUntil),
            lockedAt: Utils.toIsoString(now),
            lockedBy: Utils.getHostname(),
          },
          config.lockAtMostFor,
        );
        return new HazelcastLock(config, this);
      }

      return undefined;
    } finally {
      if (locked) {
        try {
          await store.unlock(config.name);
        } catch {
        }
      }
    }
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const now = ClockProvider.now();
    const lockAtLeastUntilValue = lockAtLeastUntil(config);
    const store = await this.client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);

    let locked = false;
    try {
      await store.lock(config.name, this.lockLeaseTimeMs);
      locked = true;

      if (now >= lockAtLeastUntilValue) {
        await store.remove(config.name);
      } else {
        await store.put(
          config.name,
          {
            lockUntil: Utils.toIsoString(lockAtLeastUntilValue),
            lockedAt: Utils.toIsoString(now),
            lockedBy: Utils.getHostname(),
          },
          config.lockAtLeastFor,
        );
      }
    } finally {
      if (locked) {
        try {
          await store.unlock(config.name);
        } catch {
        }
      }
    }
  }
}
