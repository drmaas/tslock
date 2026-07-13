import { ClockProvider, LockException, type LockProvider } from '@tslock/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { config, sleep, uniqueLockName } from './helpers.js';

export interface IntegrationTestOptions {
  timeMode?: 'mock' | 'real';
}

async function advanceTime(ms: number, mode: 'mock' | 'real', base: number): Promise<void> {
  if (mode === 'mock') {
    let current = base;
    ClockProvider.setClock(() => {
      current += ms;
      return current;
    });
  } else {
    await sleep(ms);
  }
}

export function lockProviderIntegrationTests(
  getProvider: () => Promise<LockProvider>,
  options: IntegrationTestOptions = {},
): void {
  const timeMode = options.timeMode ?? 'real';

  describe('lockProviderIntegrationTests', () => {
    let provider: LockProvider;
    let baseTime: number;

    beforeEach(async () => {
      ClockProvider.resetClock();
      baseTime = Date.now();
      provider = await getProvider();
    });

    it('shouldLockOnce', async () => {
      const lock = await provider.lock(config(uniqueLockName(), '1m'));
      expect(lock).toBeDefined();
      await lock?.unlock();
    });

    it('shouldSkipIfLocked', async () => {
      const name = uniqueLockName();
      const lock1 = await provider.lock(config(name, '1m'));
      expect(lock1).toBeDefined();
      const lock2 = await provider.lock(config(name, '1m'));
      expect(lock2).toBeUndefined();
      await lock1?.unlock();
    });

    it('shouldUnlock', async () => {
      const name = uniqueLockName();
      const lock1 = await provider.lock(config(name, '1m'));
      expect(lock1).toBeDefined();
      await lock1?.unlock();
      const lock2 = await provider.lock(config(name, '1m'));
      expect(lock2).toBeDefined();
      await lock2?.unlock();
    });

    it('shouldLockAtLeastFor', async () => {
      const name = uniqueLockName();
      const lock1 = await provider.lock(config(name, '10s', '5s'));
      expect(lock1).toBeDefined();
      await lock1?.unlock();
      const lock2 = await provider.lock(config(name, '10s'));
      expect(lock2).toBeUndefined();
      await advanceTime(6_000, timeMode, baseTime);
      const lock3 = await provider.lock(config(name, '10s'));
      expect(lock3).toBeDefined();
      await lock3?.unlock();
    });

    it('shouldNotExtendIfNotExtensible', async () => {
      const lock = await provider.lock(config(uniqueLockName(), '1m'));
      expect(lock).toBeDefined();
      try {
        const result = await lock?.extend(60_000, 0);
        expect(result).toBeUndefined();
      } catch (e) {
        expect(e).toBeInstanceOf(LockException);
      }
      try {
        await lock?.unlock();
      } catch {}
    });
  });
}
