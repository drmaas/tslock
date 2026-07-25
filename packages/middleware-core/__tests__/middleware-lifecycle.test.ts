import type { LockProvider, SimpleLock } from '@tslock/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiddlewareConfig } from '../src/index.js';
import { createLockMiddlewareLifecycle, resolveMiddlewareConfig } from '../src/index.js';
import type { LockFailureResponse } from '../src/lock-metadata.js';

function createMockLockProvider(shouldAcquire = true, onLock?: () => void, onUnlock?: () => void): LockProvider {
  let locked = false;

  return {
    async lock() {
      if (locked || !shouldAcquire) {
        return undefined;
      }
      locked = true;
      onLock?.();
      return {
        async unlock() {
          locked = false;
          onUnlock?.();
        },
        async extend() {
          return undefined;
        },
      } as SimpleLock;
    },
  };
}

function baseConfig(lp: LockProvider): MiddlewareConfig {
  return resolveMiddlewareConfig({ lockProvider: lp });
}

describe('createLockMiddlewareLifecycle', () => {
  let lockProvider: LockProvider;

  beforeEach(() => {
    lockProvider = createMockLockProvider(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lock acquired runs handler and returns wasExecuted true', async () => {
    const config = baseConfig(lockProvider);
    const lifecycle = createLockMiddlewareLifecycle(config);
    const handler = vi.fn(async () => {});
    const sendLocked = vi.fn();

    const result = await lifecycle.executeWithLock(
      { method: 'GET', path: '/api/test' },
      undefined,
      handler,
      sendLocked,
    );

    expect(result.wasExecuted).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(sendLocked).not.toHaveBeenCalled();
  });

  it('lock not acquired skips handler and sends failure response', async () => {
    lockProvider = createMockLockProvider(false);
    const config = baseConfig(lockProvider);
    const lifecycle = createLockMiddlewareLifecycle(config);
    const handler = vi.fn();
    const sendLocked = vi.fn();

    const result = await lifecycle.executeWithLock(
      { method: 'GET', path: '/api/test' },
      undefined,
      handler,
      sendLocked,
    );

    expect(result.wasExecuted).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(sendLocked).toHaveBeenCalledOnce();
    const response: LockFailureResponse = sendLocked.mock.calls[0][0];
    expect(response.status).toBe(503);
    expect(response.headers['Lock-Name']).toBe('GET:/api/test');
    expect(response.headers['Retry-After']).toBeDefined();
  });

  it('lock failure sends custom lockedStatus', async () => {
    lockProvider = createMockLockProvider(false);
    const config = resolveMiddlewareConfig({ lockProvider, defaultLockedStatus: 423 });
    const lifecycle = createLockMiddlewareLifecycle(config);
    const sendLocked = vi.fn();

    await lifecycle.executeWithLock({ method: 'GET', path: '/api/test' }, undefined, async () => {}, sendLocked);

    const response: LockFailureResponse = sendLocked.mock.calls[0][0];
    expect(response.status).toBe(423);
  });

  it('lock failure passes custom body through', async () => {
    lockProvider = createMockLockProvider(false);
    const customBody = { error: 'custom error' };
    const config = resolveMiddlewareConfig({ lockProvider, defaultLockedBody: customBody });
    const lifecycle = createLockMiddlewareLifecycle(config);
    const sendLocked = vi.fn();

    await lifecycle.executeWithLock({ method: 'GET', path: '/api/test' }, undefined, async () => {}, sendLocked);

    const response: LockFailureResponse = sendLocked.mock.calls[0][0];
    expect(response.body).toBe(customBody);
  });

  it('lock failure calls function body with metadata', async () => {
    lockProvider = createMockLockProvider(false);
    const fn = vi.fn(() => ({ dynamic: true }));
    const config = resolveMiddlewareConfig({ lockProvider, defaultLockedBody: fn });
    const lifecycle = createLockMiddlewareLifecycle(config);
    const sendLocked = vi.fn();

    await lifecycle.executeWithLock({ method: 'GET', path: '/api/test' }, undefined, async () => {}, sendLocked);

    const response: LockFailureResponse = sendLocked.mock.calls[0][0];
    expect(fn).toHaveBeenCalled();
    expect(response.body).toEqual({ dynamic: true });
  });

  it('uses route config override for lock name', async () => {
    const config = baseConfig(lockProvider);
    const lifecycle = createLockMiddlewareLifecycle(config);
    const lockSpy = vi.spyOn(lockProvider, 'lock');

    await lifecycle.executeWithLock(
      { method: 'GET', path: '/api/test' },
      { name: 'custom-lock' },
      async () => {},
      vi.fn(),
    );

    expect(lockSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'custom-lock' }));
  });

  it('lock name uses lockNamePrefix', async () => {
    const config = resolveMiddlewareConfig({ lockProvider, lockNamePrefix: 'myapp' });
    const lifecycle = createLockMiddlewareLifecycle(config);
    const lockSpy = vi.spyOn(lockProvider, 'lock');

    await lifecycle.executeWithLock({ method: 'GET', path: '/api/test' }, undefined, async () => {}, vi.fn());

    expect(lockSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'myapp:GET:/api/test' }));
  });

  it('handler error propagates', async () => {
    const config = baseConfig(lockProvider);
    const lifecycle = createLockMiddlewareLifecycle(config);

    await expect(
      lifecycle.executeWithLock(
        { method: 'GET', path: '/api/test' },
        undefined,
        async () => {
          throw new Error('handler error');
        },
        vi.fn(),
      ),
    ).rejects.toThrow('handler error');
  });

  it('unlock is called when handler succeeds', async () => {
    let unlocked = false;
    const lp = createMockLockProvider(true, undefined, () => {
      unlocked = true;
    });
    const config = baseConfig(lp);
    const lifecycle = createLockMiddlewareLifecycle(config);

    await lifecycle.executeWithLock({ method: 'GET', path: '/api/test' }, undefined, async () => {}, vi.fn());

    expect(unlocked).toBe(true);
  });

  it('unlock is called when handler throws', async () => {
    let unlocked = false;
    const lp = createMockLockProvider(true, undefined, () => {
      unlocked = true;
    });
    const config = baseConfig(lp);
    const lifecycle = createLockMiddlewareLifecycle(config);

    await expect(
      lifecycle.executeWithLock(
        { method: 'GET', path: '/api/test' },
        undefined,
        async () => {
          throw new Error('test error');
        },
        vi.fn(),
      ),
    ).rejects.toThrow('test error');

    expect(unlocked).toBe(true);
  });

  it('route lockedStatus overrides global', async () => {
    lockProvider = createMockLockProvider(false);
    const config = resolveMiddlewareConfig({ lockProvider, defaultLockedStatus: 503 });
    const lifecycle = createLockMiddlewareLifecycle(config);
    const sendLocked = vi.fn();

    await lifecycle.executeWithLock(
      { method: 'GET', path: '/api/test' },
      { lockedStatus: 409 },
      async () => {},
      sendLocked,
    );

    const response: LockFailureResponse = sendLocked.mock.calls[0][0];
    expect(response.status).toBe(409);
  });
});
