import { ClockProvider, type ExtensibleLockProvider } from '@tslock/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { config, sleep, uniqueLockName } from './helpers.js';
import { type IntegrationTestOptions, lockProviderIntegrationTests } from './integration-tests.js';

export function extensibleLockProviderIntegrationTests(
  getProvider: () => Promise<ExtensibleLockProvider>,
  options: IntegrationTestOptions = {},
): void {
  lockProviderIntegrationTests(getProvider, options);
  const timeMode = options.timeMode ?? 'real';

  describe('extensibleLockProviderIntegrationTests', () => {
    let provider: ExtensibleLockProvider;
    let baseTime: number;

    beforeEach(async () => {
      ClockProvider.resetClock();
      baseTime = Date.now();
      provider = await getProvider();
    });

    it('shouldExtendLock', async () => {
      const name = uniqueLockName();
      const lock = await provider.lock(config(name, '10s'));
      expect(lock).toBeDefined();
      if (timeMode === 'mock') {
        let current = baseTime;
        ClockProvider.setClock(() => {
          current += 6_000;
          return current;
        });
      } else {
        await sleep(6_000);
      }
      const extended = await lock?.extend(10_000, 0);
      expect(extended).toBeDefined();
      if (timeMode === 'mock') {
        let current2 = baseTime + 6_000;
        ClockProvider.setClock(() => {
          current2 += 8_000;
          return current2;
        });
      } else {
        await sleep(8_000);
      }
      const lock2 = await provider.lock(config(name, '10s'));
      expect(lock2).toBeUndefined();
      await extended?.unlock();
    });

    it('shouldNotExtendIfExpired', async () => {
      const name = uniqueLockName();
      const lock = await provider.lock(config(name, '1s'));
      expect(lock).toBeDefined();
      if (timeMode === 'mock') {
        let current = baseTime;
        ClockProvider.setClock(() => {
          current += 2_000;
          return current;
        });
      } else {
        await sleep(2_000);
      }
      const extended = await lock?.extend(10_000, 0);
      expect(extended).toBeUndefined();
    });
  });
}
