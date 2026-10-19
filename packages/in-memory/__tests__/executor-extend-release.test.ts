import { createLockConfig, DefaultLockingTaskExecutor, LockExtender, NO_OP_LISTENER } from '@tslock/core';
import { withMutableClock } from '@tslock/test-support';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryLockProvider } from '../src/in-memory-lock-provider.js';

describe('DefaultLockingTaskExecutor releases in-memory locks', () => {
  it('releases the successor after extendActiveLock', async () => {
    await withMutableClock(1_000_000, async () => {
      const provider = new InMemoryLockProvider();
      const onUnlockError = vi.fn();
      const executor = new DefaultLockingTaskExecutor(provider, { ...NO_OP_LISTENER, onUnlockError });
      const name = 'extended';

      const result = await executor.executeWithLock(
        async () => {
          await LockExtender.extendActiveLock(60_000, 0);
        },
        createLockConfig(name, 5_000, 0),
      );

      expect(result.wasExecuted).toBe(true);
      expect(provider.isLocked(name)).toBe(false);
      expect(await provider.lock(createLockConfig(name, 5_000, 0))).toBeDefined();
      expect(onUnlockError).not.toHaveBeenCalled();
    });
  });

  it('releases the original lock when the task does not extend', async () => {
    await withMutableClock(1_000_000, async () => {
      const provider = new InMemoryLockProvider();
      const executor = new DefaultLockingTaskExecutor(provider);
      const name = 'plain';

      const result = await executor.executeWithLock(async () => {}, createLockConfig(name, 5_000, 0));

      expect(result.wasExecuted).toBe(true);
      expect(await provider.lock(createLockConfig(name, 5_000, 0))).toBeDefined();
    });
  });
});
