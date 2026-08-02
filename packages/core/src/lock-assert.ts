import { AsyncLocalStorage } from 'node:async_hooks';
import { LockException } from './lock-exception.js';

export class LockAssert {
  /** @internal Reserved for testing; will be made private in v2. */
  static storage = new AsyncLocalStorage<{ stack: string[] }>();

  static assertLocked(): void {
    const store = LockAssert.storage.getStore();
    if (!store || store.stack.length === 0) {
      throw new LockException('Expected code to be running under a lock but it was not');
    }
  }

  static alreadyLockedBy(name: string): boolean {
    const store = LockAssert.storage.getStore();
    if (!store) return false;
    return store.stack.includes(name);
  }

  static runWithLock<T>(name: string, callback: () => T | Promise<T>): Promise<T> | T {
    const current = LockAssert.storage.getStore()?.stack ?? [];
    const next = [name, ...current];
    return LockAssert.storage.run({ stack: next }, callback);
  }
}
