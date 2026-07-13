import {
  ClockProvider,
  type ExtensibleLockProvider,
  type LockConfiguration,
  lockAtMostUntil,
  type SimpleLock,
} from '@tslock/core';
import { InMemoryLock } from './in-memory-lock.js';

export class InMemoryLockProvider implements ExtensibleLockProvider {
  readonly locks = new Map<string, number>();

  isLocked(name: string): boolean {
    const until = this.locks.get(name);
    if (until === undefined) return false;
    if (until <= ClockProvider.now()) {
      this.locks.delete(name);
      return false;
    }
    return true;
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    if (this.isLocked(config.name)) return undefined;
    this.locks.set(config.name, lockAtMostUntil(config));
    return new InMemoryLock(this, config);
  }
}
