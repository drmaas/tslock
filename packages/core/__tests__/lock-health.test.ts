import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '../src/clock-provider.js';
import { KeepAliveLockProvider } from '../src/keep-alive-lock-provider.js';
import { createLockConfig } from '../src/lock-configuration.js';
import { LockException } from '../src/lock-exception.js';
import { createLockHealthMonitor } from '../src/lock-health.js';
import type { LockProvider } from '../src/lock-provider.js';
import type { Disposable, Scheduler } from '../src/scheduler.js';
import type { SimpleLock } from '../src/simple-lock.js';
import { TrackingLockProviderWrapper } from '../src/tracking-lock-provider.js';

function makeLock(): SimpleLock {
  return {
    unlock: vi.fn(),
    extend: vi.fn(),
  };
}

class FakeScheduler implements Scheduler {
  callbacks = new Map<number, () => void>();
  nextId = 1;

  setInterval(cb: () => void, _ms: number): Disposable {
    const id = this.nextId++;
    this.callbacks.set(id, cb);
    return {
      clear: () => {
        this.callbacks.delete(id);
      },
    };
  }

  async tick(): Promise<void> {
    await Promise.all([...this.callbacks.values()].map((cb) => Promise.resolve(cb())));
  }
}

describe('createLockHealthMonitor', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('rejects maxKeepAliveFailures below 1', () => {
    const tracking = new TrackingLockProviderWrapper({ lock: vi.fn() });
    expect(() => createLockHealthMonitor({ tracking, maxKeepAliveFailures: 0 })).toThrow(LockException);
  });

  it('records last acquired and last skipped', () => {
    let now = 10;
    ClockProvider.setClock(() => now);
    const tracking = new TrackingLockProviderWrapper({ lock: vi.fn() });
    const health = createLockHealthMonitor({ tracking });
    const acquired = createLockConfig('a', 1_000);
    const skipped = createLockConfig('b', 2_000, 100);
    health.onLockAcquired(acquired);
    now = 20;
    health.onLockNotAcquired(skipped);
    const snap = health.snapshot();
    expect(snap.lastAcquired).toEqual({
      name: 'a',
      at: 10,
      lockAtMostFor: 1_000,
      lockAtLeastFor: 0,
    });
    expect(snap.lastSkipped).toEqual({
      name: 'b',
      at: 20,
      lockAtMostFor: 2_000,
      lockAtLeastFor: 100,
    });
  });

  it('builds a frozen JSON-serializable snapshot with active and overdue locks', async () => {
    let now = 1_000;
    ClockProvider.setClock(() => now);
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(makeLock()) };
    const tracking = new TrackingLockProviderWrapper(provider);
    await tracking.lock(createLockConfig('zebra', 500));
    await tracking.lock(createLockConfig('alpha', 5_000));
    const health = createLockHealthMonitor({ tracking });
    now = 2_000;
    const snap = health.snapshot();
    expect(snap.takenAt).toBe(2_000);
    expect(snap.activeLocks.map((lock) => lock.name)).toEqual(['alpha', 'zebra']);
    expect(snap.overdueLocks.map((lock) => lock.name)).toEqual(['zebra']);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.activeLocks)).toBe(true);
    expect(Object.isFrozen(snap.overdueLocks)).toBe(true);
    expect(Object.isFrozen(snap.recentKeepAliveFailures)).toBe(true);
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(JSON.parse(JSON.stringify(snap)).activeLocks).toHaveLength(2);
  });

  it('does not mark locks overdue when age equals lockAtMostFor', async () => {
    let now = 1_000;
    ClockProvider.setClock(() => now);
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(makeLock()) };
    const tracking = new TrackingLockProviderWrapper(provider);
    await tracking.lock(createLockConfig('edge', 1_000));
    const health = createLockHealthMonitor({ tracking });
    now = 2_000;
    expect(health.snapshot().overdueLocks).toEqual([]);
    now = 2_001;
    expect(health.snapshot().overdueLocks.map((lock) => lock.name)).toEqual(['edge']);
  });

  it('keep-alive renewals through tracking refresh updatedAt and clear overdue', async () => {
    let now = 1_000;
    ClockProvider.setClock(() => now);
    const scheduler = new FakeScheduler();
    const storageLock = makeLock();
    const renewed = makeLock();
    (storageLock.extend as ReturnType<typeof vi.fn>).mockResolvedValue(renewed);
    const storage: LockProvider = { lock: vi.fn().mockResolvedValue(storageLock) };
    const tracking = new TrackingLockProviderWrapper(storage);
    const keepAlive = new KeepAliveLockProvider(tracking, scheduler);
    const health = createLockHealthMonitor({ tracking });

    await keepAlive.lock(createLockConfig('ka', 30_000));
    expect(tracking.getActiveLockRecords()[0]?.updatedAt).toBe(1_000);

    now = 32_000;
    expect(health.snapshot().overdueLocks.map((lock) => lock.name)).toEqual(['ka']);

    now = 16_000;
    await scheduler.tick();
    expect(tracking.getActiveLockRecords()[0]?.updatedAt).toBe(16_000);
    expect(health.snapshot().overdueLocks).toEqual([]);

    now = 40_000;
    expect(health.snapshot().overdueLocks).toEqual([]);
    now = 50_000;
    expect(health.snapshot().overdueLocks.map((lock) => lock.name)).toEqual(['ka']);
  });

  it('tracking outside keep-alive does not refresh updatedAt on renewals', async () => {
    let now = 1_000;
    ClockProvider.setClock(() => now);
    const scheduler = new FakeScheduler();
    const storageLock = makeLock();
    const renewed = makeLock();
    (storageLock.extend as ReturnType<typeof vi.fn>).mockResolvedValue(renewed);
    const storage: LockProvider = { lock: vi.fn().mockResolvedValue(storageLock) };
    const keepAlive = new KeepAliveLockProvider(storage, scheduler);
    const tracking = new TrackingLockProviderWrapper(keepAlive);
    const health = createLockHealthMonitor({ tracking });

    await tracking.lock(createLockConfig('ka', 30_000));
    expect(tracking.getActiveLockRecords()[0]?.updatedAt).toBe(1_000);

    now = 16_000;
    await scheduler.tick();
    expect(tracking.getActiveLockRecords()[0]?.updatedAt).toBe(1_000);
    now = 32_000;
    expect(health.snapshot().overdueLocks.map((lock) => lock.name)).toEqual(['ka']);
  });

  it('keeps keep-alive failures in a ring buffer', () => {
    let now = 0;
    ClockProvider.setClock(() => {
      now += 1;
      return now;
    });
    const tracking = new TrackingLockProviderWrapper({ lock: vi.fn() });
    const health = createLockHealthMonitor({ tracking, maxKeepAliveFailures: 2 });
    const config = createLockConfig('ka', 30_000);
    health.onKeepAliveFailure(config, new TypeError('boom'));
    health.onKeepAliveFailure(config, new LockException('lost'));
    health.onKeepAliveFailure(config, { not: 'an-error' });
    const failures = health.snapshot().recentKeepAliveFailures;
    expect(failures).toHaveLength(2);
    expect(failures[0]?.errorType).toBe('LockException');
    expect(failures[1]?.errorType).toBe('Error');
    expect(failures[0]?.name).toBe('ka');
    expect(failures[1]?.at).toBeGreaterThan(failures[0]!.at);
  });

  it('formatSnapshot includes active lock names', async () => {
    ClockProvider.setClock(() => 50);
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(makeLock()) };
    const tracking = new TrackingLockProviderWrapper(provider);
    await tracking.lock(createLockConfig('nightly-cleanup', 1_000));
    const health = createLockHealthMonitor({ tracking });
    health.onLockAcquired(createLockConfig('nightly-cleanup', 1_000));
    const text = health.formatSnapshot();
    expect(text).toContain('nightly-cleanup');
    expect(text).toContain('activeLocks: 1');
    expect(text).toContain('lastAcquired: nightly-cleanup');
  });

  it('exposes no-op listener methods expected by LockingTaskExecutorListener', () => {
    const tracking = new TrackingLockProviderWrapper({ lock: vi.fn() });
    const health = createLockHealthMonitor({ tracking });
    const config = createLockConfig('t', 1000);
    expect(() => health.onLockAttempt(config)).not.toThrow();
    expect(() => health.onTaskStarted(config)).not.toThrow();
    expect(() => health.onTaskFinished(config, 12)).not.toThrow();
    expect(() => health.onUnlockError?.(config, new Error('x'))).not.toThrow();
  });
});
