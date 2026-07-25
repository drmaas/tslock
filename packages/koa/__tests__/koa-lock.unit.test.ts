import type { LockProvider, SimpleLock } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { createKoaLock } from '../src/index.js';

function createMockContext(method: string, path: string) {
  return {
    method,
    path,
    status: 200,
    body: undefined as unknown,
    set: vi.fn(),
    response: {} as Record<string, unknown>,
  };
}

function createMockLockProvider(shouldAcquire = true): LockProvider {
  let locked = false;
  return {
    async lock() {
      if (locked || !shouldAcquire) return undefined;
      locked = true;
      return {
        async unlock() {
          locked = false;
        },
        async extend() {
          return undefined;
        },
      } as SimpleLock;
    },
  };
}

describe('createKoaLock', () => {
  it('extracts method and path from ctx', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    expect(typeof middleware).toBe('function');
    expect(tslock.lockProvider).toBe(lp);
  });

  it('lock failure sets ctx.status and ctx.body', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(ctx as any, next);

    expect(ctx.status).toBe(503);
    expect(ctx.body).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('lock success calls next', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(ctx as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('unlocks after handler completes', async () => {
    let unlocked = false;
    const lp: LockProvider = {
      async lock() {
        return {
          async unlock() {
            unlocked = true;
          },
          async extend() {
            return undefined;
          },
        } as SimpleLock;
      },
    };
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(ctx as any, next);

    expect(unlocked).toBe(true);
  });

  it('unlocks in finally when handler throws', async () => {
    let unlocked = false;
    const lp: LockProvider = {
      async lock() {
        return {
          async unlock() {
            unlocked = true;
          },
          async extend() {
            return undefined;
          },
        } as SimpleLock;
      },
    };
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn().mockRejectedValue(new Error('handler error'));

    await expect(middleware(ctx as any, next)).rejects.toThrow('handler error');
    expect(unlocked).toBe(true);
  });

  it('uses custom lockedStatus', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock({ lockedStatus: 423 });

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(ctx as any, next);

    expect(ctx.status).toBe(423);
  });

  it('lock provider error propagates (storage error)', async () => {
    const errorLp: LockProvider = {
      async lock() {
        throw new Error('storage error');
      },
    };
    const tslock = createKoaLock({ lockProvider: errorLp });
    const middleware = tslock();

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await expect(middleware(ctx as any, next)).rejects.toThrow('storage error');
  });

  it('uses _matchedRoute when available', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    const ctx = { ...createMockContext('GET', '/api/users/123'), _matchedRoute: '/api/users/:id' };
    const next = vi.fn();

    await middleware(ctx as any, next);

    expect(next).toHaveBeenCalled();
  });
});
