import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '../src/clock-provider.js';
import { KeepAliveLockProvider } from '../src/keep-alive-lock-provider.js';
import { createLockConfig } from '../src/lock-configuration.js';
import { LockException } from '../src/lock-exception.js';
import { type ExtensibleLockProvider, extensibleLockProvider } from '../src/lock-provider.js';
import type { Disposable, Scheduler } from '../src/scheduler.js';
import type { SimpleLock } from '../src/simple-lock.js';

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
}

function makeProvider(opts: { lockReturn?: 'lock' | 'undefined'; extendReturn?: 'newLock' | 'undefined' } = {}): {
  provider: ExtensibleLockProvider;
  unlockMock: ReturnType<typeof vi.fn>;
  extendMock: ReturnType<typeof vi.fn>;
} {
  const unlockMock = vi.fn();
  const extendMock = vi.fn();
  const initialLock: SimpleLock = { unlock: unlockMock, extend: extendMock };
  const newLock: SimpleLock = { unlock: vi.fn(), extend: vi.fn() };
  if (opts.extendReturn === 'undefined') {
    extendMock.mockResolvedValue(undefined);
  } else {
    extendMock.mockResolvedValue(newLock);
  }
  const provider: ExtensibleLockProvider = {
    [extensibleLockProvider]: true,
    lock: vi.fn().mockImplementation(() => {
      if (opts.lockReturn === 'undefined') return Promise.resolve(undefined);
      return Promise.resolve(initialLock);
    }),
  };
  return { provider, unlockMock, extendMock };
}

describe('KeepAliveLockProvider', () => {
  let scheduler: FakeScheduler;
  beforeEach(() => {
    scheduler = new FakeScheduler();
  });
  afterEach(() => {
    vi.useRealTimers();
    ClockProvider.resetClock();
  });

  it('throws when lockAtMostFor < 30s', async () => {
    const { provider } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    await expect(kap.lock(createLockConfig('t', 1000))).rejects.toThrow(LockException);
  });

  it('returns undefined when wrapped provider returns undefined', async () => {
    const { provider } = makeProvider({ lockReturn: 'undefined' });
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const result = await kap.lock(createLockConfig('t', 60_000));
    expect(result).toBeUndefined();
  });

  it('schedules interval on lock', async () => {
    const { provider } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = await kap.lock(createLockConfig('t', 60_000));
    expect(lock).toBeDefined();
    expect(scheduler.callbacks.size).toBe(1);
  });

  it('extend called on interval tick', async () => {
    const { provider, extendMock } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const _lock = await kap.lock(createLockConfig('t', 60_000));
    const cb = [...scheduler.callbacks.values()][0]!;
    await cb();
    expect(extendMock).toHaveBeenCalled();
  });

  it('unlock cancels interval and calls wrapped unlock', async () => {
    const { provider, unlockMock } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    expect(scheduler.callbacks.size).toBe(1);
    await lock.unlock();
    expect(scheduler.callbacks.size).toBe(0);
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('manual extend throws', async () => {
    const { provider } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    await expect(lock.extend(60_000, 0)).rejects.toThrow(LockException);
  });

  it('transient extend failure retries once and keeps the interval alive', async () => {
    const { provider, extendMock } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const _lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    extendMock.mockRejectedValueOnce(new Error('transient'));
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(extendMock).toHaveBeenCalledTimes(2);
    expect(scheduler.callbacks.size).toBe(1);
  });

  it('extend failure twice stops the interval and notifies onKeepAliveFailure', async () => {
    const { provider, extendMock } = makeProvider();
    const onKeepAliveFailure = vi.fn();
    const kap = new KeepAliveLockProvider(provider, scheduler, onKeepAliveFailure);
    const _lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    extendMock.mockRejectedValue(new Error('extend-boom'));
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(extendMock).toHaveBeenCalledTimes(2);
    expect(scheduler.callbacks.size).toBe(0);
    expect(onKeepAliveFailure).toHaveBeenCalledOnce();
    const [cfg, error] = onKeepAliveFailure.mock.calls[0]!;
    expect(cfg.name).toBe('t');
    expect((error as Error).message).toBe('extend-boom');
  });

  it('extend returning undefined stops the interval and notifies lock lost', async () => {
    const { provider } = makeProvider({ extendReturn: 'undefined' });
    const onKeepAliveFailure = vi.fn();
    const kap = new KeepAliveLockProvider(provider, scheduler, onKeepAliveFailure);
    const _lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(scheduler.callbacks.size).toBe(0);
    expect(onKeepAliveFailure).toHaveBeenCalledOnce();
    const [cfg, error] = onKeepAliveFailure.mock.calls[0]!;
    expect(cfg.name).toBe('t');
    expect((error as Error).message).toBe('Keep-alive lock was lost');
  });

  it('renews past the original lockAtMostUntil and keeps the interval', async () => {
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const { provider, extendMock } = makeProvider();
    const renewed: SimpleLock = { unlock: vi.fn(), extend: extendMock as SimpleLock['extend'] };
    extendMock.mockResolvedValue(renewed);
    const kap = new KeepAliveLockProvider(provider, scheduler);
    await kap.lock(createLockConfig('t', 60_000));

    for (const at of [1_030_000, 1_060_000, 1_090_000]) {
      now = at;
      const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
      await cb();
    }

    expect(extendMock).toHaveBeenCalledTimes(3);
    expect(scheduler.callbacks.size).toBe(1);
  });

  it('stops and notifies when the renewed deadline has passed', async () => {
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const { provider, extendMock } = makeProvider();
    const renewed: SimpleLock = { unlock: vi.fn(), extend: extendMock as SimpleLock['extend'] };
    extendMock.mockResolvedValue(renewed);
    const onKeepAliveFailure = vi.fn();
    const kap = new KeepAliveLockProvider(provider, scheduler, onKeepAliveFailure);
    await kap.lock(createLockConfig('t', 60_000));

    now = 1_030_000;
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(extendMock).toHaveBeenCalledTimes(1);

    now = 1_090_001;
    await cb();
    expect(extendMock).toHaveBeenCalledTimes(1);
    expect(scheduler.callbacks.size).toBe(0);
    expect(onKeepAliveFailure).toHaveBeenCalledOnce();
    const [cfg, error] = onKeepAliveFailure.mock.calls[0]!;
    expect(cfg.name).toBe('t');
    expect(error).toBeInstanceOf(LockException);
    expect((error as Error).message).toBe('Keep-alive lock was lost');
  });

  it('unlocking before the original deadline cancels the interval and unlocks the wrapped lock', async () => {
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const { provider, unlockMock } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    expect(scheduler.callbacks.size).toBe(1);

    now = 1_030_000;
    await lock.unlock();
    expect(scheduler.callbacks.size).toBe(0);
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('unlock after a failed keep-alive still releases the underlying lock', async () => {
    const { provider, unlockMock, extendMock } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    extendMock.mockRejectedValue(new Error('extend-boom'));
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(scheduler.callbacks.size).toBe(0);
    await lock.unlock();
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('unlock after a lost renewal does not call the wrapped unlock', async () => {
    const { provider, unlockMock } = makeProvider({ extendReturn: 'undefined' });
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(scheduler.callbacks.size).toBe(0);
    await lock.unlock();
    expect(unlockMock).not.toHaveBeenCalled();
  });

  it('unlocks the renewed lock when a lost renewal overlaps a successful one', async () => {
    const unlockMock = vi.fn();
    const renewedUnlock = vi.fn();
    let resolveFirst: (value: SimpleLock | undefined) => void = () => {};
    let resolveSecond: (value: SimpleLock | undefined) => void = () => {};
    const renewed: SimpleLock = { unlock: renewedUnlock, extend: vi.fn() };
    const extendMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SimpleLock | undefined>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<SimpleLock | undefined>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const initialLock: SimpleLock = { unlock: unlockMock, extend: extendMock };
    const provider: ExtensibleLockProvider = {
      [extensibleLockProvider]: true,
      lock: vi.fn().mockResolvedValue(initialLock),
    };
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;

    const firstTick = cb();
    await vi.waitFor(() => expect(extendMock).toHaveBeenCalledTimes(1));
    const secondTick = cb();
    await vi.waitFor(() => expect(extendMock).toHaveBeenCalledTimes(2));

    resolveSecond(undefined);
    await secondTick;
    resolveFirst(renewed);
    await firstTick;

    await lock.unlock();
    expect(renewedUnlock).toHaveBeenCalledOnce();
    expect(unlockMock).not.toHaveBeenCalled();
  });

  it('keeps the renewed lock when an earlier in-flight renewal succeeds', async () => {
    const unlockMock = vi.fn();
    const renewedUnlock = vi.fn();
    let resolveFirst: (value: SimpleLock | undefined) => void = () => {};
    let resolveSecond: (value: SimpleLock | undefined) => void = () => {};
    const renewed: SimpleLock = { unlock: renewedUnlock, extend: vi.fn() };
    const extendMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SimpleLock | undefined>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<SimpleLock | undefined>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const initialLock: SimpleLock = { unlock: unlockMock, extend: extendMock };
    const provider: ExtensibleLockProvider = {
      [extensibleLockProvider]: true,
      lock: vi.fn().mockResolvedValue(initialLock),
    };
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;

    const firstTick = cb();
    await vi.waitFor(() => expect(extendMock).toHaveBeenCalledTimes(1));
    const secondTick = cb();
    await vi.waitFor(() => expect(extendMock).toHaveBeenCalledTimes(2));

    resolveFirst(renewed);
    await firstTick;
    resolveSecond(undefined);
    await secondTick;

    await lock.unlock();
    expect(renewedUnlock).toHaveBeenCalledOnce();
    expect(unlockMock).not.toHaveBeenCalled();
  });

  it('unlock after the deadline-passed tick does not call the wrapped unlock', async () => {
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const { provider, unlockMock, extendMock } = makeProvider();
    const kap = new KeepAliveLockProvider(provider, scheduler);
    const lock = (await kap.lock(createLockConfig('t', 60_000)))!;
    now = 1_060_001;
    const cb = [...scheduler.callbacks.values()][0] as unknown as () => Promise<void>;
    await cb();
    expect(extendMock).not.toHaveBeenCalled();
    expect(scheduler.callbacks.size).toBe(0);
    await lock.unlock();
    expect(unlockMock).not.toHaveBeenCalled();
  });
});
