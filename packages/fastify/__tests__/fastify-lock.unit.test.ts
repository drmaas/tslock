import type { LockProvider, SimpleLock } from '@tslock/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createFastifyLockPlugin } from '../src/index.js';

function createMockRequest(method: string, url: string, routeUrl?: string) {
  return {
    method,
    url,
    routeOptions: routeUrl ? { url: routeUrl } : undefined,
  };
}

function createMockReply() {
  const reply = {
    statusCode: 200,
    sent: undefined as unknown,
    status: vi.fn(),
    send: vi.fn(),
    // biome-ignore lint/suspicious/noThenProperty: Fastify reply is a thenable
    then: vi.fn(),
    headers: vi.fn(),
  };
  reply.status.mockReturnThis();
  reply.headers.mockReturnThis();
  reply.then.mockImplementation((cb: () => void, _rej?: (_: Error) => void) => {
    cb();
  });
  return reply;
}

function createMockFastify() {
  return {
    decorate: vi.fn(),
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

describe('createFastifyLockPlugin', () => {
  it('decorates fastify with tslock', () => {
    const lp = createMockLockProvider(true);
    const plugin = createFastifyLockPlugin({ lockProvider: lp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);

    expect(fastify.decorate).toHaveBeenCalledWith('tslock', expect.any(Function));
    expect(doneFn).toHaveBeenCalled();
  });

  it('preHandler blocks handler when lock not acquired', async () => {
    const lp = createMockLockProvider(false);
    const plugin = createFastifyLockPlugin({ lockProvider: lp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);
    const tslock = fastify.decorate.mock.calls[0][1];
    const preHandler = tslock();

    const req = createMockRequest('GET', '/api/test', '/api/test');
    const reply = createMockReply();
    const done = vi.fn();

    preHandler(req as unknown as FastifyRequest, reply as unknown as FastifyReply, done);

    await vi.waitFor(
      () => {
        expect(reply.status).toHaveBeenCalledWith(503);
        expect(reply.send).toHaveBeenCalled();
        expect(done).not.toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('preHandler allows handler when lock acquired', async () => {
    const lp = createMockLockProvider(true);
    const plugin = createFastifyLockPlugin({ lockProvider: lp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);
    const tslock = fastify.decorate.mock.calls[0][1];
    const preHandler = tslock();

    const req = createMockRequest('GET', '/api/test', '/api/test');
    const reply = createMockReply();
    const done = vi.fn();

    preHandler(req as unknown as FastifyRequest, reply as unknown as FastifyReply, done);

    await vi.waitFor(
      () => {
        expect(done).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('uses request.routeOptions.url when available', async () => {
    const lp = createMockLockProvider(true);
    const plugin = createFastifyLockPlugin({ lockProvider: lp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);
    const tslock = fastify.decorate.mock.calls[0][1];
    const preHandler = tslock();

    const req = createMockRequest('GET', '/raw-url', '/api/users/:id');
    const reply = createMockReply();
    const done = vi.fn();

    preHandler(req as unknown as FastifyRequest, reply as unknown as FastifyReply, done);

    await vi.waitFor(
      () => {
        expect(done).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
  });

  it('custom lockedStatus overrides global', async () => {
    const lp = createMockLockProvider(false);
    const plugin = createFastifyLockPlugin({ lockProvider: lp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);
    const tslock = fastify.decorate.mock.calls[0][1];
    const preHandler = tslock({ lockedStatus: 423 });

    const req = createMockRequest('GET', '/api/test', '/api/test');
    const reply = createMockReply();
    const done = vi.fn();

    preHandler(req as unknown as FastifyRequest, reply as unknown as FastifyReply, done);

    await vi.waitFor(
      () => {
        expect(reply.status).toHaveBeenCalledWith(423);
      },
      { timeout: 2000 },
    );
  });

  it('lock provider error calls done with error', async () => {
    const errorLp: LockProvider = {
      async lock() {
        throw new Error('storage error');
      },
    };
    const plugin = createFastifyLockPlugin({ lockProvider: errorLp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);
    const tslock = fastify.decorate.mock.calls[0][1];
    const preHandler = tslock();

    const req = createMockRequest('GET', '/api/test', '/api/test');
    const reply = createMockReply();
    const done = vi.fn();

    preHandler(req as unknown as FastifyRequest, reply as unknown as FastifyReply, done);

    await vi.waitFor(
      () => {
        expect(done).toHaveBeenCalledWith(expect.any(Error));
      },
      { timeout: 2000 },
    );
  });

  it('lockFactory exposes lockProvider and config', () => {
    const lp = createMockLockProvider(true);
    const plugin = createFastifyLockPlugin({ lockProvider: lp });
    const fastify = createMockFastify();
    const doneFn = vi.fn();

    plugin(fastify as unknown as FastifyInstance, {}, doneFn);
    const tslock = fastify.decorate.mock.calls[0][1];

    expect(tslock.lockProvider).toBe(lp);
    expect(tslock.config).toBeDefined();
  });
});
