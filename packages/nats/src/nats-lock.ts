import {
  AbstractSimpleLock,
  ClockProvider,
  type LockConfiguration,
  lockAtLeastUntil,
  lockAtMostUntil,
} from '@tslock/core';
import type { KV } from 'nats';
import { bytesToLong, longToBytes } from './long-utils.js';

export class NatsLock extends AbstractSimpleLock {
  constructor(
    private readonly kv: KV,
    config: LockConfiguration,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    const entry = await this.kv.get(this.config.name);
    if (entry === null) return;

    const lockUntil = bytesToLong(entry.value);
    if (lockUntil > lockAtMostUntil(this.config)) return;

    const now = ClockProvider.now();
    if (lockAtLeastUntil(this.config) > now) {
      await this.kv.update(this.config.name, longToBytes(lockAtLeastUntil(this.config)), entry.revision);
    } else {
      await this.kv.delete(this.config.name);
    }
  }
}
