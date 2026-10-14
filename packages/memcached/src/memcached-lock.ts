import {
  AbstractSimpleLock,
  ClockProvider,
  type LockConfiguration,
  LockException,
  lockAtLeastUntil,
  Utils,
} from '@tslock/core';
import type { Client as MemjsClient } from 'memjs';

export class MemcachedLock extends AbstractSimpleLock {
  constructor(
    private readonly client: MemjsClient,
    private readonly key: string,
    private readonly value: string,
    config: LockConfiguration,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    const current = await this.client.get(this.key);
    if (!sameBytes(current.value, this.value)) return;

    const keepLockFor = lockAtLeastUntil(this.config) - ClockProvider.now();
    if (keepLockFor <= 0) {
      const result = await this.client.delete(this.key);
      if (!result) {
        throw new LockException(`Can not unlock ${this.config.name} from memcached`);
      }
    } else {
      const keepLockForSeconds = Utils.toTtlSeconds(keepLockFor);
      const result = await this.client.replace(this.key, this.value, { expires: keepLockForSeconds });
      if (!result) {
        throw new LockException(`Can not unlock ${this.config.name} from memcached`);
      }
    }
  }
}

function sameBytes(stored: Buffer | null, expected: string): boolean {
  if (stored === null) return false;
  return stored.equals(Buffer.from(expected));
}
