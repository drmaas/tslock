import { AsyncLocalStorage } from 'node:async_hooks';
import { type DurationInput, parseDuration } from './duration.js';
import { LockCanNotBeExtendedException, NoActiveLockException } from './lock-exception.js';
import type { SimpleLock } from './simple-lock.js';

const ACTIVE_LOCK_INDEX = 0;

export class LockExtender {
  private static storage = new AsyncLocalStorage<{ stack: SimpleLock[] }>();

  static async extendActiveLock(lockAtMostFor: DurationInput, lockAtLeastFor: DurationInput): Promise<void> {
    const store = LockExtender.storage.getStore();
    if (!store || store.stack.length === 0) {
      throw new NoActiveLockException();
    }
    const current = store.stack[ACTIVE_LOCK_INDEX]!;
    const most = parseDuration(lockAtMostFor);
    const least = parseDuration(lockAtLeastFor);
    const newLock = await current.extend(most, least);
    if (!newLock) {
      throw new LockCanNotBeExtendedException();
    }
    store.stack[ACTIVE_LOCK_INDEX] = newLock;
  }

  static runWithLock<T>(lock: SimpleLock, callback: () => T | Promise<T>): Promise<T> | T {
    const current = LockExtender.storage.getStore()?.stack ?? [];
    const next = [lock, ...current];
    return LockExtender.storage.run({ stack: next }, callback);
  }
}
