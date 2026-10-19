import { ClockProvider, createLockConfig, type Disposable, KeepAliveLockProvider, type Scheduler } from '@tslock/core';
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

  it('shared ClockProvider advance past lockUntil is isomorphic to peer skew past remaining TTL', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const provider = new InMemoryLockProvider();
      const lockAtMostFor = 10_000;
      expect(await provider.lock(createLockConfig('ahead-node', lockAtMostFor))).toBeDefined();

      const writerElapsed = 3_000;
      const remainingTtl = lockAtMostFor - writerElapsed;
      const peerAheadBy = remainingTtl + 1;
      clock.advance(writerElapsed + peerAheadBy);

      expect(await provider.lock(createLockConfig('ahead-node', lockAtMostFor))).toBeDefined();
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

  it('rejects extend after another caller reacquires the lock', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const provider = new InMemoryLockProvider();
      const first = (await provider.lock(createLockConfig('job', 5_000)))!;

      clock.advance(5_001);
      const second = (await provider.lock(createLockConfig('job', 60_000)))!;
      const deadline = provider.locks.get('job');
      expect(deadline).toBe(clock.now() + 60_000);

      expect(await first.extend(60_000, 0)).toBeUndefined();
      expect(provider.locks.get('job')).toBe(deadline);
      expect(await provider.lock(createLockConfig('job', 5_000))).toBeUndefined();

      await second.unlock();
    });
  });

  it('notifies onKeepAliveFailure when a renewal runs after another caller reacquires', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const storage = new InMemoryLockProvider();
      const scheduler = new ManualScheduler();
      const onKeepAliveFailure = vi.fn();
      const keepAlive = new KeepAliveLockProvider(storage, scheduler, onKeepAliveFailure);

      const first = await keepAlive.lock(createLockConfig('job', 30_000));
      expect(first).toBeDefined();

      storage.locks.delete('job');
      clock.advance(1_000);
      const second = await storage.lock(createLockConfig('job', 60_000));
      expect(second).toBeDefined();
      const deadline = storage.locks.get('job');
      expect(deadline).toBe(clock.now() + 60_000);

      await scheduler.tickAll();

      expect(onKeepAliveFailure).toHaveBeenCalledOnce();
      const [, error] = onKeepAliveFailure.mock.calls[0]!;
      expect((error as Error).message).toBe('Keep-alive lock was lost');
      expect(storage.locks.get('job')).toBe(deadline);
    });
  });

  it('leaves the new holder in place when unlock follows a lost renewal', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const storage = new InMemoryLockProvider();
      const scheduler = new ManualScheduler();
      const onKeepAliveFailure = vi.fn();
      const keepAlive = new KeepAliveLockProvider(storage, scheduler, onKeepAliveFailure);
      const name = 'lost-renewal';

      const first = (await keepAlive.lock(createLockConfig(name, 30_000)))!;
      storage.locks.delete(name);
      clock.advance(1_000);
      expect(await storage.lock(createLockConfig(name, 60_000))).toBeDefined();
      const deadline = storage.locks.get(name);
      expect(deadline).toBe(clock.now() + 60_000);

      await scheduler.tickAll();
      expect(onKeepAliveFailure).toHaveBeenCalledOnce();
      const [, error] = onKeepAliveFailure.mock.calls[0]!;
      expect((error as Error).message).toBe('Keep-alive lock was lost');

      await first.unlock();
      expect(storage.locks.get(name)).toBe(deadline);
      expect(storage.isLocked(name)).toBe(true);
    });
  });

  it('leaves the new holder in place when unlock follows a deadline-passed tick', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const storage = new InMemoryLockProvider();
      const scheduler = new ManualScheduler();
      const onKeepAliveFailure = vi.fn();
      const keepAlive = new KeepAliveLockProvider(storage, scheduler, onKeepAliveFailure);
      const name = 'deadline-passed';

      const first = (await keepAlive.lock(createLockConfig(name, 30_000)))!;
      clock.advance(30_001);
      expect(await storage.lock(createLockConfig(name, 60_000))).toBeDefined();
      const deadline = storage.locks.get(name);
      expect(deadline).toBe(clock.now() + 60_000);

      await scheduler.tickAll();
      expect(onKeepAliveFailure).toHaveBeenCalledOnce();
      const [, error] = onKeepAliveFailure.mock.calls[0]!;
      expect((error as Error).message).toBe('Keep-alive lock was lost');

      await first.unlock();
      expect(storage.locks.get(name)).toBe(deadline);
      expect(storage.isLocked(name)).toBe(true);
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
