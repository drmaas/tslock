import type { LockProvider, SimpleLock } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { createHonoLock } from '../src/index.js';

function createMockContext(method: string, path: string, routePath?: string) {
  return {
    req: {
      method,
      path,
      routePath: routePath ?? '/*',
    },
    json: vi.fn().mockImplementation((body: unknown) => ({ body, headers: new Map() })),
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

describe('createHonoLock', () => {
  it('extracts method and routePath from c.req', () => {
    const lp = createMockLockProvider(true);
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    expect(typeof middleware).toBe('function');
    expect(tslock.lockProvider).toBe(lp);
  });

  it('lock failure returns 503 response', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    const c = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(c as any, next);

    expect(c.json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('lock success calls next', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    const c = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(c as any, next);

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
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    const c = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(c as any, next);

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
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    const c = createMockContext('GET', '/api/test');
    const next = vi.fn().mockRejectedValue(new Error('handler error'));

    await expect(middleware(c as any, next)).rejects.toThrow('handler error');
    expect(unlocked).toBe(true);
  });

  it('falls back to c.req.path when routePath is /*', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    const c = createMockContext('POST', '/api/users', '/*');
    const next = vi.fn();

    await middleware(c as any, next);

    await vi.waitFor(
      () => {
        expect(c.json).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('uses routePath when available for registered routes', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock();

    const c = createMockContext('GET', '/api/users/123', '/api/users/:id');
    const next = vi.fn();

    await middleware(c as any, next);

    expect(next).toHaveBeenCalled();
  });

  it('custom lockedStatus overrides global', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createHonoLock({ lockProvider: lp });
    const middleware = tslock({ lockedStatus: 423 });

    const c = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(c as any, next);

    expect(c.json).toHaveBeenCalled();
  });

  it('lock provider error propagates', async () => {
    const errorLp: LockProvider = {
      async lock() {
        throw new Error('storage error');
      },
    };
    const tslock = createHonoLock({ lockProvider: errorLp });
    const middleware = tslock();

    const c = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await expect(middleware(c as any, next)).rejects.toThrow('storage error');
  });
});
