import { LockAssert } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastifyLockPlugin } from '../src/index.js';

describe('Fastify lock integration', () => {
  afterEach(async () => {});

  it('acquires lock, returns 200 from handler', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({ lockProvider: provider, lockAtMostFor: 10000 });
    plugin(fastify, {}, () => {});

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async () => {
      return { ok: true };
    });

    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 503 when lock is held by concurrent request', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({ lockProvider: provider, lockAtMostFor: 10000 });
    plugin(fastify, {}, () => {});

    let releaseBarrier: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async () => {
      await barrier;
      return { ok: true };
    });

    await fastify.ready();

    const firstReq = fastify.inject({ method: 'GET', url: '/api/locked' });
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res2.statusCode).toBe(503);
    expect(res2.headers['retry-after']).toBeDefined();
    expect(res2.headers['lock-name']).toBeDefined();

    releaseBarrier!();
    const res1 = await firstReq;
    expect(res1.statusCode).toBe(200);
  });

  it('re-acquires lock after first handler completes', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({
      lockProvider: provider,
      lockAtMostFor: 5000,
      lockAtLeastFor: 0,
    });
    plugin(fastify, {}, () => {});

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async () => {
      return { ok: true };
    });

    await fastify.ready();

    const res1 = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res1.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    const res2 = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res2.statusCode).toBe(200);
  });

  it('different HTTP methods use different lock names', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({ lockProvider: provider, lockAtMostFor: 10000 });
    plugin(fastify, {}, () => {});

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async (req: any) => {
      return { method: req.method };
    });
    fastify.post('/api/locked', { preHandler: (fastify as any).tslock() }, async (req: any) => {
      return { method: req.method };
    });

    await fastify.ready();

    const [getRes, postRes] = await Promise.all([
      fastify.inject({ method: 'GET', url: '/api/locked' }),
      fastify.inject({ method: 'POST', url: '/api/locked' }),
    ]);

    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
  });

  it('custom lockedStatus returns custom status code', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({
      lockProvider: provider,
      lockAtMostFor: 10000,
      defaultLockedStatus: 423,
    });
    plugin(fastify, {}, () => {});

    let releaseBarrier: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async () => {
      await barrier;
      return { ok: true };
    });

    await fastify.ready();

    const firstReq = fastify.inject({ method: 'GET', url: '/api/locked' });
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res2.statusCode).toBe(423);

    releaseBarrier!();
    await firstReq;
  });

  it('LockAssert.assertLocked works inside handler', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({ lockProvider: provider, lockAtMostFor: 10000 });
    plugin(fastify, {}, () => {});

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async () => {
      LockAssert.assertLocked();
      return { assertion: 'success' };
    });

    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ assertion: 'success' });
  });

  it('handler error releases lock', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({ lockProvider: provider, lockAtMostFor: 5000, lockAtLeastFor: 0 });
    plugin(fastify, {}, () => {});

    fastify.get('/api/locked', { preHandler: (fastify as any).tslock() }, async () => {
      throw new Error('handler crash');
    });

    await fastify.ready();

    const res1 = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res1.statusCode).toBe(500);
    await new Promise((r) => setTimeout(r, 200));

    const res2 = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res2.statusCode).toBe(500);
  });

  it('reentrancy: nested preHandler executes handler once', async () => {
    const provider = new InMemoryLockProvider();
    const fastify = Fastify();
    const plugin = createFastifyLockPlugin({
      lockProvider: provider,
      lockAtMostFor: 10000,
      lockNamePrefix: 'reentrancy-fastify',
    });
    plugin(fastify, {}, () => {});

    let handlerCalls = 0;
    fastify.get('/api/locked', { preHandler: [(fastify as any).tslock(), (fastify as any).tslock()] }, async () => {
      handlerCalls++;
      return { called: handlerCalls };
    });

    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/api/locked' });
    expect(res.statusCode).toBe(200);
    expect(handlerCalls).toBe(1);
  });
});
