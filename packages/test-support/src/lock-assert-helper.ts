import { LockAssert } from '@tslock/core';

const TEST_LOCK_NAME = '__tslock_test_helper__';

export const TestHelper = {
  makeAllAssertsPass(value: boolean): void {
    const current = LockAssert.storage.getStore()?.stack ?? [];
    if (value) {
      LockAssert.storage.enterWith({ stack: [TEST_LOCK_NAME, ...current] });
    } else {
      const [, ...rest] = current;
      LockAssert.storage.enterWith({ stack: rest });
    }
  },
};
