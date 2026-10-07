import { EventEmitter } from 'node:events';
import type { LockProvider, SimpleLock } from '@tslock/core';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createExpressLock } from '../src/index.js';

function createMockRequest(
  method: string,
  path: string,
  options: {
    baseUrl?: string;
    routePath?: string | RegExp;
    caseSensitiveRouting?: boolean;
    strictRouting?: boolean;
  } = {},
) {
  return {
    method,
    path,
    baseUrl: options.baseUrl ?? '',
    route: options.routePath !== undefined ? { path: options.routePath } : undefined,
    app: {
      get(name: string) {
        if (name === 'case sensitive routing') return options.caseSensitiveRouting ?? false;
        if (name === 'strict routing') return options.strictRouting ?? false;
        return undefined;
      },
    },
  };
}

function createCapturingLockProvider() {
  const lockNames: string[] = [];
  const provider: LockProvider = {
    async lock(config) {
      lockNames.push(config.name);
      return {
        async unlock() {},
        async extend() {
          return undefined;
        },
      } as SimpleLock;
    },
  };
  return { provider, lockNames };
}

function createMockResponse() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    set: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  res.statusCode = 200;
  res.set = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  res.off = vi.fn().mockReturnValue(res);
  return res;
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

describe('createExpressLock', () => {
  it('extracts method and path from req for lock name', () => {
    const lp = createMockLockProvider(true);
    const tslock = createExpressLock({ lockProvider: lp });
    const middleware = tslock();

    expect(typeof middleware).toBe('function');
    expect(tslock.lockProvider).toBe(lp);
    expect(tslock.config.lockAtMostFor).toBe(30000);
  });

  it('lock failure sends 503 with JSON body', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createExpressLock({ lockProvider: lp });
    const middleware = tslock();

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.set).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('lock success calls next', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createExpressLock({ lockProvider: lp });
    const middleware = tslock();

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(next).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('unlocks on response finish', async () => {
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
    const tslock = createExpressLock({ lockProvider: lp });
    const middleware = tslock();

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(next).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    res.emit('finish');

    await vi.waitFor(
      () => {
        expect(unlocked).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it('unlocks on response close (client disconnect)', async () => {
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
    const tslock = createExpressLock({ lockProvider: lp });
    const middleware = tslock();

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(next).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    res.emit('close');

    await vi.waitFor(
      () => {
        expect(unlocked).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it('uses custom lockedStatus', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createExpressLock({ lockProvider: lp });
    const middleware = tslock({ lockedStatus: 423 });

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(res.status).toHaveBeenCalledWith(423);
      },
      { timeout: 2000 },
    );
  });

  it('custom lockedBody function receives metadata', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createExpressLock({ lockProvider: lp });
    const bodyFn = vi.fn(() => ({ custom: true }));
    const middleware = tslock({ lockedBody: bodyFn });

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(bodyFn).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('lock provider error propagates via next(err)', async () => {
    const errorLp: LockProvider = {
      async lock() {
        throw new Error('storage error');
      },
    };
    const tslock = createExpressLock({ lockProvider: errorLp });
    const middleware = tslock();

    const req = createMockRequest('GET', '/api/test');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(next).toHaveBeenCalledWith(expect.any(Error));
      },
      { timeout: 2000 },
    );
  });

  it('uses matched route path with baseUrl for lock name', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const tslock = createExpressLock({ lockProvider: provider });
    const middleware = tslock();

    const req = createMockRequest('GET', '/items/9', {
      baseUrl: '/api',
      routePath: '/items/:id',
    });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(lockNames).toEqual(['GET:/api/items/:id']);
      },
      { timeout: 2000 },
    );
  });

  it('lowercases lock path when case sensitive routing is off', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const tslock = createExpressLock({ lockProvider: provider });
    const middleware = tslock();

    const req = createMockRequest('GET', '/RUN', {
      baseUrl: '/API',
      routePath: '/run',
      caseSensitiveRouting: false,
    });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(lockNames).toEqual(['GET:/api/run']);
      },
      { timeout: 2000 },
    );
  });

  it('strips trailing slash when strict routing is off', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const tslock = createExpressLock({ lockProvider: provider });
    const middleware = tslock();

    const req = createMockRequest('GET', '/x/', {
      baseUrl: '/use-only',
      caseSensitiveRouting: false,
      strictRouting: false,
    });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(lockNames).toEqual(['GET:/use-only/x']);
      },
      { timeout: 2000 },
    );
  });

  it('preserves case and trailing slash when Express routing settings are enabled', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const tslock = createExpressLock({ lockProvider: provider });
    const middleware = tslock();

    const req = createMockRequest('GET', '/Run/', {
      baseUrl: '/API',
      routePath: '/Run/',
      caseSensitiveRouting: true,
      strictRouting: true,
    });
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req as unknown as Request, res as unknown as Response, next as NextFunction);

    await vi.waitFor(
      () => {
        expect(lockNames).toEqual(['GET:/API/Run/']);
      },
      { timeout: 2000 },
    );
  });
});
