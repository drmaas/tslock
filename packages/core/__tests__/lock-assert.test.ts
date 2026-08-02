import { describe, expect, it } from 'vitest';
import { LockAssert } from '../src/lock-assert.js';
import { LockException } from '../src/lock-exception.js';

describe('LockAssert', () => {
  it('assertLocked throws outside lock context', () => {
    expect(() => LockAssert.assertLocked()).toThrow(LockException);
  });

  it('assertLocked passes inside runWithLock', () => {
    LockAssert.runWithLock('my-lock', () => {
      expect(() => LockAssert.assertLocked()).not.toThrow();
    });
  });

  it('alreadyLockedBy returns true for active lock', () => {
    LockAssert.runWithLock('my-lock', () => {
      expect(LockAssert.alreadyLockedBy('my-lock')).toBe(true);
    });
  });

  it('alreadyLockedBy returns false for different name', () => {
    LockAssert.runWithLock('my-lock', () => {
      expect(LockAssert.alreadyLockedBy('other')).toBe(false);
    });
  });

  it('alreadyLockedBy returns false outside lock context', () => {
    expect(LockAssert.alreadyLockedBy('my-lock')).toBe(false);
  });

  it('alreadyLockedBy scans the whole stack (nested reentrancy)', () => {
    LockAssert.runWithLock('foo', () => {
      LockAssert.runWithLock('bar', () => {
        expect(LockAssert.alreadyLockedBy('foo')).toBe(true);
        expect(LockAssert.alreadyLockedBy('bar')).toBe(true);
      });
    });
  });
});
