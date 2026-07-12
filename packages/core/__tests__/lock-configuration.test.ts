import { afterEach, describe, expect, it } from 'vitest';
import { ClockProvider } from '../src/clock-provider.js';
import {
  createLockConfig,
  lockAtLeastUntil,
  lockAtMostUntil,
  unlockTime,
} from '../src/lock-configuration.js';
import { LockException } from '../src/lock-exception.js';

describe('LockConfiguration', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('createLockConfig with valid inputs', () => {
    ClockProvider.setClock(() => 1_000_000);
    const config = createLockConfig('test', 30_000, 5_000);
    expect(config.name).toBe('test');
    expect(config.lockAtMostFor).toBe(30_000);
    expect(config.lockAtLeastFor).toBe(5_000);
    expect(config.createdAt).toBe(1_000_000);
  });

  it('createLockConfig defaults lockAtLeastFor to 0', () => {
    const config = createLockConfig('test', '1m');
    expect(config.lockAtLeastFor).toBe(0);
  });

  it('accepts duration input strings', () => {
    const config = createLockConfig('test', '5m', '30s');
    expect(config.lockAtMostFor).toBe(300_000);
    expect(config.lockAtLeastFor).toBe(30_000);
  });

  it('throws on empty name', () => {
    expect(() => createLockConfig('', 30_000)).toThrow(LockException);
  });

  it('throws on negative lockAtMostFor', () => {
    expect(() => createLockConfig('test', -1)).toThrow(LockException);
  });

  it('throws when lockAtLeastFor > lockAtMostFor', () => {
    expect(() => createLockConfig('test', 1_000, 2_000)).toThrow(LockException);
  });

  it('lockAtMostUntil returns createdAt + lockAtMostFor', () => {
    const config = createLockConfig('test', 30_000);
    expect(lockAtMostUntil(config)).toBe(config.createdAt + 30_000);
  });

  it('lockAtLeastUntil returns createdAt + lockAtLeastFor', () => {
    const config = createLockConfig('test', 30_000, 5_000);
    expect(lockAtLeastUntil(config)).toBe(config.createdAt + 5_000);
  });

  it('unlockTime returns max(now, lockAtLeastUntil)', () => {
    ClockProvider.setClock(() => 1_000_000);
    const config = createLockConfig('test', 30_000, 5_000);
    const atLeast = lockAtLeastUntil(config);
    expect(unlockTime(config)).toBe(Math.max(1_000_000, atLeast));
  });
});
