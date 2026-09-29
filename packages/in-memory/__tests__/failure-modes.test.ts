import { ClockProvider, type Disposable, KeepAliveLockProvider, type Scheduler, createLockConfig } from '@tslock/core';
import { type MutableClock, withMutableClock } from '@tslock/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryLockProvider } from '../src/in-memory-lock-provider.js';

class ManualScheduler implements Scheduler {
  readonly callbacks = new Map<number, () => void>();
  private nextId = 1;

  setInterval(cb: () => void, _ms: number): Disposable {
    const id = this.nextId++;
    this.callbacks.set(id, cb);
    return {
      clear: () => {
        this.callbacks.delete(id);
      },
    };
  }

  async tickAll(): Promise<void> {
    for (const cb of [...this.callbacks.values()]) {
      await cb();
    }
  }
}

describe('documented failure modes (in-memory harness)', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('allows a second acquisition when the clock advances past lockUntil (skew / overrun)', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const provider = new InMemoryLockProvider();
      const first = await provider.lock(createLockConfig('skew', 5_000));
      expect(first).toBeDefined();

      expect(await provider.lock(createLockConfig('skew', 5_000))).toBeUndefined();

      clock.advance(5_001);
      const second = await provider.lock(createLockConfig('skew', 5_000));
      expect(second).toBeDefined();
    });
  });

  it('maps shared-clock advance to another node being ahead of the writer', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const provider = new InMemoryLockProvider();
      const lockAtMostFor = 10_000;
      const first = await provider.lock(createLockConfig('ahead-node', lockAtMostFor));
      expect(first).toBeDefined();

      const remainingTtl = 7_000;
      const skewPastExpiry = remainingTtl + 1;
      clock.advance(lockAtMostFor - remainingTtl + skewPastExpiry);

      const second = await provider.lock(createLockConfig('ahead-node', lockAtMostFor));
      expect(second).toBeDefined();
    });
  });

  it('allows re-acquisition after early eviction while the first SimpleLock is still held', async () => {
    await withMutableClock(1_000_000, async () => {
      const provider = new InMemoryLockProvider();
      const first = await provider.lock(createLockConfig('evict', 60_000));
      expect(first).toBeDefined();
      expect(provider.isLocked('evict')).toBe(true);

      provider.locks.delete('evict');

      const second = await provider.lock(createLockConfig('evict', 60_000));
      expect(second).toBeDefined();
      expect(provider.isLocked('evict')).toBe(true);
    });
  });

  it('allows re-acquisition when keep-alive renewals never run and lockAtMostFor elapses', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const storage = new InMemoryLockProvider();
      const scheduler = new ManualScheduler();
      const onKeepAliveFailure = vi.fn();
      const keepAlive = new KeepAliveLockProvider(storage, scheduler, onKeepAliveFailure);

      const first = await keepAlive.lock(createLockConfig('keepalive', 30_000));
      expect(first).toBeDefined();
      expect(scheduler.callbacks.size).toBe(1);

      clock.advance(30_001);
      const second = await storage.lock(createLockConfig('keepalive', 30_000));
      expect(second).toBeDefined();
      expect(onKeepAliveFailure).not.toHaveBeenCalled();
    });
  });

  it('notifies onKeepAliveFailure when renewals run after the storage lease was lost', async () => {
    await withMutableClock(1_000_000, async () => {
      const storage = new InMemoryLockProvider();
      const scheduler = new ManualScheduler();
      const onKeepAliveFailure = vi.fn();
      const keepAlive = new KeepAliveLockProvider(storage, scheduler, onKeepAliveFailure);

      const first = await keepAlive.lock(createLockConfig('lost-renewal', 30_000));
      expect(first).toBeDefined();

      storage.locks.delete('lost-renewal');
      expect(storage.isLocked('lost-renewal')).toBe(false);

      await scheduler.tickAll();
      expect(onKeepAliveFailure).toHaveBeenCalled();
      const [, error] = onKeepAliveFailure.mock.calls[0]!;
      expect((error as Error).message).toBe('Keep-alive lock was lost');
    });
  });

  it('shows stale unlock after re-acquisition can overwrite the new holder (in-memory)', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const provider = new InMemoryLockProvider();
      const first = (await provider.lock(createLockConfig('stale-unlock', 5_000, 0)))!;

      clock.advance(5_001);
      const second = (await provider.lock(createLockConfig('stale-unlock', 60_000)))!;
      expect(provider.locks.get('stale-unlock')).toBe(clock.now() + 60_000);

      await first.unlock();
      expect(provider.locks.get('stale-unlock')).toBe(1_000_000);
      expect(provider.isLocked('stale-unlock')).toBe(false);

      await second.unlock();
    });
  });

  it('keeps lockAtLeastFor as a small-drift buffer after unlock, not a skew cure', async () => {
    await withMutableClock(1_000_000, async (clock: MutableClock) => {
      const provider = new InMemoryLockProvider();
      const lock = (await provider.lock(createLockConfig('least', 10_000, 4_000)))!;
      await lock.unlock();

      clock.advance(2_000);
      expect(await provider.lock(createLockConfig('least', 10_000))).toBeUndefined();

      clock.advance(3_000);
      expect(await provider.lock(createLockConfig('least', 10_000))).toBeDefined();
    });
  });
});
