import { LockAssert } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createHonoLock } from '../src/index.js';

function createHonoApp() {
  const app = new Hono();
  app.onError(() => new Response(null, { status: 500 }));
  return app;
}

describe('Hono lock integration', () => {
  it('acquires lock, returns 200 from handler', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 10000 });
    const app = createHonoApp();
    app.get('/api/locked', tslock(), (c) => c.json({ ok: true }));

    const res = await app.request('/api/locked');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 503 when lock is held by concurrent request', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 10000 });

    let releaseBarrier: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    const app = createHonoApp();
    app.get('/api/locked', tslock(), (c) => {
      return barrier.then(() => c.json({ ok: true }));
    });

    const firstReq = app.request('/api/locked');
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await app.request('/api/locked');
    expect(res2.status).toBe(503);
    expect(res2.headers.get('retry-after')).toBeTruthy();
    expect(res2.headers.get('lock-name')).toBeTruthy();

    releaseBarrier!();
    const res1 = await firstReq;
    expect(res1.status).toBe(200);
  });

  it('re-acquires lock after first handler completes', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 5000, lockAtLeastFor: 0 });
    const app = createHonoApp();
    app.get('/api/locked', tslock(), (c) => c.json({ ok: true }));

    const res1 = await app.request('/api/locked');
    expect(res1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    const res2 = await app.request('/api/locked');
    expect(res2.status).toBe(200);
  });

  it('different HTTP methods use different lock names', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 10000 });
    const app = createHonoApp();
    app.get('/api/locked', tslock(), (c) => c.json({ method: c.req.method }));
    app.post('/api/locked', tslock(), (c) => c.json({ method: c.req.method }));

    const [getRes, postRes] = await Promise.all([
      app.request('/api/locked', { method: 'GET' }),
      app.request('/api/locked', { method: 'POST' }),
    ]);
    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
  });

  it('custom lockedStatus returns custom status code', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 10000, defaultLockedStatus: 423 });

    let releaseBarrier: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    const app = createHonoApp();
    app.get('/api/locked', tslock(), (c) => {
      return barrier.then(() => c.json({ ok: true }));
    });

    const firstReq = app.request('/api/locked');
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await app.request('/api/locked');
    expect(res2.status).toBe(423);

    releaseBarrier!();
    await firstReq;
  });

  it('handler error returns 500 and lock is released', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 5000, lockAtLeastFor: 0 });
    const app = createHonoApp();
    app.get('/api/locked', tslock(), () => {
      throw new Error('handler crash');
    });

    const res1 = await app.request('/api/locked');
    expect(res1.status).toBe(500);
    await new Promise((r) => setTimeout(r, 200));
    const res2 = await app.request('/api/locked');
    expect(res2.status).toBe(500);
  });

  it('LockAssert.assertLocked works inside handler', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 10000 });
    const app = createHonoApp();
    app.get('/api/locked', tslock(), (c) => {
      LockAssert.assertLocked();
      return c.json({ assertion: 'success' });
    });

    const res = await app.request('/api/locked');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assertion: 'success' });
  });

  it('reentrancy: nested middleware executes handler once', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createHonoLock({ lockProvider: provider, lockAtMostFor: 10000, lockNamePrefix: 'reentrancy-hono' });
    const app = createHonoApp();
    let handlerCalls = 0;
    app.get('/api/locked', tslock(), tslock(), (c) => {
      handlerCalls++;
      return c.json({ called: handlerCalls });
    });

    const res = await app.request('/api/locked');
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });
});
