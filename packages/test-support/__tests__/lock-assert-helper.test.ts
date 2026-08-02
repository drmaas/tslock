import { LockAssert, LockException } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { TestHelper } from '../src/lock-assert-helper.js';

describe('TestHelper.makeAllAssertsPass', () => {
  it('makes assertLocked pass when enabled and restores when disabled', () => {
    TestHelper.makeAllAssertsPass(true);
    try {
      expect(() => LockAssert.assertLocked()).not.toThrow();
    } finally {
      TestHelper.makeAllAssertsPass(false);
    }
    expect(() => LockAssert.assertLocked()).toThrow(LockException);
  });

  it('pops the pushed context on disable', () => {
    TestHelper.makeAllAssertsPass(true);
    TestHelper.makeAllAssertsPass(false);
    expect(() => LockAssert.assertLocked()).toThrow(LockException);
  });

  it('is safe to disable without a prior enable', () => {
    TestHelper.makeAllAssertsPass(false);
    expect(() => LockAssert.assertLocked()).toThrow(LockException);
  });
});
