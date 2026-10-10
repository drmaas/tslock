import http from 'node:http';
import type { LockConfiguration, LockProvider, SimpleLock } from '@tslock/core';
import type { Context } from 'koa';
import Koa from 'koa';
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

function createCapturingLockProvider() {
  const lockNames: string[] = [];
  const provider: LockProvider = {
    async lock(config: LockConfiguration) {
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

function httpRequest(port: number, method: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end();
  });
}

async function withReadmeApp(lockProvider: LockProvider, run: (port: number) => Promise<void>): Promise<void> {
  const app = new Koa();
  const tslock = createKoaLock({ lockProvider });
  app.use(tslock());
  app.use((ctx) => {
    ctx.body = { ok: true };
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('expected a TCP port');
  }

  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
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

    await middleware(ctx as unknown as Context, next);

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

    await middleware(ctx as unknown as Context, next);

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

    await middleware(ctx as unknown as Context, next);

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

    await expect(middleware(ctx as unknown as Context, next)).rejects.toThrow('handler error');
    expect(unlocked).toBe(true);
  });

  it('uses custom lockedStatus', async () => {
    const lp = createMockLockProvider(false);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock({ lockedStatus: 423 });

    const ctx = createMockContext('GET', '/api/test');
    const next = vi.fn();

    await middleware(ctx as unknown as Context, next);

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

    await expect(middleware(ctx as unknown as Context, next)).rejects.toThrow('storage error');
  });

  it('uses _matchedRoute when available', async () => {
    const lp = createMockLockProvider(true);
    const tslock = createKoaLock({ lockProvider: lp });
    const middleware = tslock();

    const ctx = { ...createMockContext('GET', '/api/users/123'), _matchedRoute: '/api/users/:id' };
    const next = vi.fn();

    await middleware(ctx as unknown as Context, next);

    expect(next).toHaveBeenCalled();
  });

  it('records POST:/run-billing for case and trailing-slash variants on the README app', async () => {
    const { provider, lockNames } = createCapturingLockProvider();

    await withReadmeApp(provider, async (port) => {
      await httpRequest(port, 'POST', '/run-billing');
      await httpRequest(port, 'POST', '/RUN-BILLING');
      await httpRequest(port, 'POST', '/run-billing/');
    });

    expect(lockNames).toEqual(['POST:/run-billing', 'POST:/run-billing', 'POST:/run-billing']);
  });

  it('records GET:/jobs/:id when _matchedRoute is set', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const middleware = createKoaLock({ lockProvider: provider })();
    const ctx = { ...createMockContext('GET', '/jobs/42'), _matchedRoute: '/jobs/:id' };

    await middleware(ctx as unknown as Context, vi.fn());

    expect(lockNames).toEqual(['GET:/jobs/:id']);
  });

  it('uses ctx.path when _matchedRoute is an empty string', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const middleware = createKoaLock({ lockProvider: provider })();
    const ctx = { ...createMockContext('GET', '/Run/'), _matchedRoute: '' };

    await middleware(ctx as unknown as Context, vi.fn());

    expect(lockNames).toEqual(['GET:/run']);
  });

  it('records the same lock name with and without a query string', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const middleware = createKoaLock({ lockProvider: provider })();
    const next = vi.fn();

    await middleware(createMockContext('GET', '/run-billing?x=1') as unknown as Context, next);
    await middleware(createMockContext('GET', '/run-billing') as unknown as Context, next);

    expect(lockNames[0]).toBe(lockNames[1]);
    expect(lockNames).toEqual(['GET:/run-billing', 'GET:/run-billing']);
  });

  it('keeps case and a trailing slash when router opts are sensitive and strict', async () => {
    const { provider, lockNames } = createCapturingLockProvider();
    const middleware = createKoaLock({ lockProvider: provider })();
    const next = vi.fn();

    await middleware(
      {
        ...createMockContext('GET', '/API/Run/'),
        router: { opts: { sensitive: true, strict: true } },
      } as unknown as Context,
      next,
    );
    await middleware(createMockContext('GET', '/API/Run/') as unknown as Context, next);

    expect(lockNames).toEqual(['GET:/API/Run/', 'GET:/api/run']);
    expect(lockNames[0]).not.toBe(lockNames[1]);
  });
});
