import { EventEmitter } from 'node:events';
import type { LockProvider, SimpleLock } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { createExpressLock } from '../src/index.js';

function createMockRequest(method: string, path: string) {
  return { method, path };
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

    middleware(req as any, res as any, next);

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

    middleware(req as any, res as any, next);

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

    middleware(req as any, res as any, next);

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

    middleware(req as any, res as any, next);

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

    middleware(req as any, res as any, next);

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

    middleware(req as any, res as any, next);

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

    middleware(req as any, res as any, next);

    await vi.waitFor(
      () => {
        expect(next).toHaveBeenCalledWith(expect.any(Error));
      },
      { timeout: 2000 },
    );
  });
});
