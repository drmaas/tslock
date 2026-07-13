import { ClockProvider, type LockProvider, type SimpleLock } from '@tslock/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { config, sleep, uniqueLockName } from './helpers.js';

export function fuzzTests(getProvider: () => Promise<LockProvider>): void {
  describe('fuzzTests', () => {
    let provider: LockProvider;

    beforeEach(async () => {
      ClockProvider.resetClock();
      provider = await getProvider();
    });

    it('shouldHandleConcurrentLockAttempts', async () => {
      for (let i = 0; i < 10; i++) {
        const name = uniqueLockName('fuzz');
        const promises = Array.from({ length: 50 }, () => provider.lock(config(name, '30s')));
        const results = await Promise.all(promises);
        const locks = results.filter((r) => r !== undefined);
        expect(locks.length).toBe(1);
        await locks[0]!.unlock();
      }
    });

    it('shouldHandleFuzzWithExtend', async () => {
      const name = uniqueLockName('fuzz-ext');
      let maxConcurrent = 0;
      let current = 0;
      const start = Date.now();
      const workers = Array.from({ length: 20 }, async () => {
        while (Date.now() - start < 1_000) {
          const lock = await provider.lock(config(name, '5s'));
          if (!lock) {
            await sleep(Math.floor(Math.random() * 10));
            continue;
          }
          current++;
          maxConcurrent = Math.max(maxConcurrent, current);
          try {
            await sleep(Math.floor(Math.random() * 30));
            let active: SimpleLock = lock;
            try {
              const extended = await lock.extend(5_000, 0);
              if (extended) active = extended;
            } catch {}
            await sleep(Math.floor(Math.random() * 30));
            await active.unlock();
          } finally {
            current--;
          }
        }
      });
      await Promise.all(workers);
      expect(maxConcurrent).toBeLessThanOrEqual(1);
    });
  });
}
