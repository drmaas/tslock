import { AsyncLocalStorage } from 'node:async_hooks';
import { LockException } from './lock-exception.js';

const SENTINEL = '__tslock_test_sentinel__';
const LOCK_NAME_INDEX = 0;

export class LockAssert {
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
    return store.stack[LOCK_NAME_INDEX] === name;
  }

  static runWithLock<T>(name: string, callback: () => T | Promise<T>): Promise<T> | T {
    const current = LockAssert.storage.getStore()?.stack ?? [];
    const next = [name, ...current];
    return LockAssert.storage.run({ stack: next }, callback);
  }
}

export namespace LockAssert {
  export namespace TestHelper {
    export function makeAllAssertsPass(value: boolean): void {
      const current = LockAssert.storage.getStore()?.stack ?? [];
      if (value) {
        LockAssert.storage.enterWith({ stack: [SENTINEL, ...current] });
      } else {
        const [, ...rest] = current;
        LockAssert.storage.enterWith({ stack: rest });
      }
    }
  }
}
