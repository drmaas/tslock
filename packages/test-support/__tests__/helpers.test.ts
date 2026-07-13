import type { LockProvider } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { cleanupLock, config, sleep, uniqueLockName } from '../src/helpers.js';

describe('config', () => {
  it('produces valid LockConfiguration', () => {
    const c = config('test', '1m', '30s');
    expect(c.name).toBe('test');
    expect(c.lockAtMostFor).toBe(60_000);
    expect(c.lockAtLeastFor).toBe(30_000);
  });

  it('defaults lockAtLeastFor to 0', () => {
    const c = config('test', '5s');
    expect(c.lockAtLeastFor).toBe(0);
  });

  it('accepts number input', () => {
    const c = config('test', 5000);
    expect(c.lockAtMostFor).toBe(5000);
  });
});

describe('sleep', () => {
  it('resolves after approximately the right time', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('uniqueLockName', () => {
  it('produces unique names', () => {
    const a = uniqueLockName();
    const b = uniqueLockName();
    expect(a).not.toBe(b);
  });

  it('accepts a prefix', () => {
    const name = uniqueLockName('fuzz');
    expect(name.startsWith('fuzz-')).toBe(true);
  });
});

describe('cleanupLock', () => {
  it('best-effort: no error when no lock exists', async () => {
    const provider: LockProvider = {
      lock: vi.fn().mockResolvedValue(undefined),
    };
    await cleanupLock(provider, 'test');
  });

  it('unlocks when lock acquired', async () => {
    const unlockMock = vi.fn();
    const lock = { unlock: unlockMock, extend: vi.fn() };
    const provider: LockProvider = {
      lock: vi.fn().mockResolvedValue(lock),
    };
    await cleanupLock(provider, 'test');
    expect(unlockMock).toHaveBeenCalled();
  });
});
