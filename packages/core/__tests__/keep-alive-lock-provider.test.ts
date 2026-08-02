import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepAliveLockProvider } from '../src/keep-alive-lock-provider.js';
import { createLockConfig } from '../src/lock-configuration.js';
import { LockException } from '../src/lock-exception.js';
import type { ExtensibleLockProvider } from '../src/lock-provider.js';
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
});
