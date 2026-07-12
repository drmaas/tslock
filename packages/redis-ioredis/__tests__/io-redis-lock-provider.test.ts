import { describe, expect, it, vi } from 'vitest';
import { createLockConfig } from '@tslock/core';
import {
  DEL_IF_EQUALS_SCRIPT,
  EXTEND_IF_EQUALS_SCRIPT,
} from '@tslock/redis-core';
import { IoRedisLockProvider } from '../src/io-redis-lock-provider.js';

function makeClient() {
  const del = vi.fn().mockResolvedValue(1);
  const evalFn = vi.fn().mockResolvedValue(1);
  return {
    call: vi.fn().mockResolvedValue('OK'),
    del,
    eval: evalFn,
  };
}

describe('IoRedisLockProvider', () => {
  it('lock() calls client.call with SET NX PX', async () => {
    const client = makeClient();
    const provider = new IoRedisLockProvider(client as never);
    const lock = await provider.lock(createLockConfig('t', 60_000));
    expect(lock).toBeDefined();
    expect(client.call).toHaveBeenCalledOnce();
    const args = client.call.mock.calls[0]!;
    expect(args[0]).toBe('SET');
    expect(Number(args[5])).toBeGreaterThan(59_000);
  });

  it('lock() returns undefined when call returns null', async () => {
    const client = { ...makeClient(), call: vi.fn().mockResolvedValue(null) };
    const provider = new IoRedisLockProvider(client as never);
    const lock = await provider.lock(createLockConfig('t', 60_000));
    expect(lock).toBeUndefined();
  });

  it('unlock() with safeUpdate=true calls eval with DEL script', async () => {
    const client = makeClient();
    const provider = new IoRedisLockProvider(client as never, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    await lock.unlock();
    expect(client.eval).toHaveBeenCalled();
    expect(client.eval.mock.calls[0]![0]).toBe(DEL_IF_EQUALS_SCRIPT);
  });

  it('unlock() with safeUpdate=false calls del', async () => {
    const client = makeClient();
    const provider = new IoRedisLockProvider(client as never, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    await lock.unlock();
    expect(client.del).toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('extend() with safeUpdate=true calls eval with EXTEND script', async () => {
    const client = makeClient();
    const provider = new IoRedisLockProvider(client as never, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(client.eval).toHaveBeenCalled();
    expect(client.eval.mock.calls[0]![0]).toBe(EXTEND_IF_EQUALS_SCRIPT);
  });

  it('extend() returns undefined when eval returns 0', async () => {
    const client = { ...makeClient(), eval: vi.fn().mockResolvedValue(0) };
    const provider = new IoRedisLockProvider(client as never);
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() with safeUpdate=false calls client.call with SET XX PX', async () => {
    const client = makeClient();
    const provider = new IoRedisLockProvider(client as never, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    const callCalls = client.call.mock.calls;
    const lastCall = callCalls[callCalls.length - 1]!;
    expect(lastCall[0]).toBe('SET');
    expect(lastCall[3]).toBe('XX');
  });

  it('uses custom keyPrefix and env', async () => {
    const client = makeClient();
    const provider = new IoRedisLockProvider(client as never, { keyPrefix: 'myapp', env: 'prod' });
    const lock = await provider.lock(createLockConfig('t', 60_000));
    expect(lock).toBeDefined();
    expect(client.call.mock.calls[0]![1]).toBe('myapp:prod:t');
  });
});
