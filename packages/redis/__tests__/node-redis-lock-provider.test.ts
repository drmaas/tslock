import { createLockConfig } from '@tslock/core';
import { DEL_IF_EQUALS_SCRIPT, EXTEND_IF_EQUALS_SCRIPT } from '@tslock/redis-core';
import { describe, expect, it, vi } from 'vitest';
import { NodeRedisLockProvider } from '../src/node-redis-lock-provider.js';

function makeClient() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe('NodeRedisLockProvider', () => {
  it('lock() calls client.set with NX + PX', async () => {
    const client = makeClient();
    const provider = new NodeRedisLockProvider(client as never);
    const lock = await provider.lock(createLockConfig('t', 60_000));
    expect(lock).toBeDefined();
    expect(client.set).toHaveBeenCalledOnce();
    const args = client.set.mock.calls[0]!;
    expect(args[2].NX).toBe(true);
    expect(args[2].PX).toBeGreaterThan(59_000);
  });

  it('lock() returns undefined when set returns null (key exists)', async () => {
    const client = { ...makeClient(), set: vi.fn().mockResolvedValue(null) };
    const provider = new NodeRedisLockProvider(client as never);
    const lock = await provider.lock(createLockConfig('t', 60_000));
    expect(lock).toBeUndefined();
  });

  it('unlock() with safeUpdate=true calls eval with DEL script', async () => {
    const client = makeClient();
    const provider = new NodeRedisLockProvider(client as never, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    await lock.unlock();
    expect(client.eval).toHaveBeenCalled();
    expect(client.eval.mock.calls[0]?.[0]).toBe(DEL_IF_EQUALS_SCRIPT);
  });

  it('unlock() with safeUpdate=false calls del', async () => {
    const client = makeClient();
    const provider = new NodeRedisLockProvider(client as never, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    await lock.unlock();
    expect(client.del).toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('extend() with safeUpdate=true calls eval with EXTEND script', async () => {
    const client = makeClient();
    const provider = new NodeRedisLockProvider(client as never, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(client.eval).toHaveBeenCalled();
    expect(client.eval.mock.calls[0]?.[0]).toBe(EXTEND_IF_EQUALS_SCRIPT);
  });

  it('extend() returns undefined when eval returns 0', async () => {
    const client = { ...makeClient(), eval: vi.fn().mockResolvedValue(0) };
    const provider = new NodeRedisLockProvider(client as never);
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() with safeUpdate=false calls set with XX + PX', async () => {
    const client = makeClient();
    const provider = new NodeRedisLockProvider(client as never, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    const lastSetCall = client.set.mock.calls[client.set.mock.calls.length - 1]!;
    expect(lastSetCall[2]).toEqual({ XX: true, PX: expect.any(Number) });
  });

  it('uses custom keyPrefix and env', async () => {
    const client = makeClient();
    const provider = new NodeRedisLockProvider(client as never, { keyPrefix: 'myapp', env: 'prod' });
    const lock = await provider.lock(createLockConfig('t', 60_000));
    expect(lock).toBeDefined();
    expect(client.set.mock.calls[0]?.[0]).toBe('myapp:prod:t');
  });
});
