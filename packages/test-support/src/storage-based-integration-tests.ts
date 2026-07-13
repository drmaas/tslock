import { ClockProvider, type StorageAccessor, type StorageBasedLockProvider } from '@tslock/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { config, sleep, uniqueLockName } from './helpers.js';
import { type IntegrationTestOptions, lockProviderIntegrationTests } from './integration-tests.js';

export interface StorageBasedIntegrationTestOptions extends IntegrationTestOptions {
  getAccessor?: () => Promise<StorageAccessor>;
}

export function storageBasedLockProviderIntegrationTests(
  getProvider: () => Promise<StorageBasedLockProvider>,
  options: StorageBasedIntegrationTestOptions = {},
): void {
  lockProviderIntegrationTests(getProvider, options);
  const timeMode = options.timeMode ?? 'real';

  describe('storageBasedLockProviderIntegrationTests', () => {
    let provider: StorageBasedLockProvider;
    let accessor: StorageAccessor | undefined;
    let baseTime: number;

    beforeEach(async () => {
      ClockProvider.resetClock();
      baseTime = Date.now();
      provider = await getProvider();
      accessor = options.getAccessor ? await options.getAccessor() : undefined;
    });

    it('shouldCreateLockRecord', async () => {
      const name = uniqueLockName();
      const lock = await provider.lock(config(name, '1m'));
      expect(lock).toBeDefined();
      await lock!.unlock();
      if (accessor) {
        const inserted = await accessor.insertRecord(config(name, '1m'));
        expect(inserted).toBe(false);
      }
    });

    it('shouldNotCreateDuplicateRecord', async () => {
      const name = uniqueLockName();
      const lock = await provider.lock(config(name, '1m'));
      expect(lock).toBeDefined();
      if (accessor) {
        const inserted = await accessor.insertRecord(config(name, '1m'));
        expect(inserted).toBe(false);
      }
      await lock!.unlock();
    });

    it('shouldUpdateRecordIfExpired', async () => {
      const name = uniqueLockName();
      const lock1 = await provider.lock(config(name, '1s'));
      expect(lock1).toBeDefined();
      await lock1!.unlock();
      if (timeMode === 'mock') {
        let current = baseTime;
        ClockProvider.setClock(() => {
          current += 2_000;
          return current;
        });
      } else {
        await sleep(2_000);
      }
      const lock2 = await provider.lock(config(name, '1m'));
      expect(lock2).toBeDefined();
      await lock2!.unlock();
    });
  });
}
