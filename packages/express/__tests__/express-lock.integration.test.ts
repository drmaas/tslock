import type { Server } from 'node:http';
import http from 'node:http';
import { LockAssert } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExpressLock } from '../src/index.js';

describe('Express lock integration', () => {
  let port: number;
  let server: Server | null;

  beforeEach(() => {
    port = 30000 + Math.floor(Math.random() * 10000);
    server = null;
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  function startServer(app: express.Express): Promise<Server> {
    return new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(port, () => resolve(s));
    });
  }

  function makeRequest(
    path: string,
    method = 'GET',
  ): Promise<{
    status: number;
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('acquires lock, returns 200 from handler', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 10000 });
    const app = express();
    app.get('/api/locked', tslock(), (_req, res) => {
      res.json({ ok: true });
    });

    server = await startServer(app);
    const res = await makeRequest('/api/locked');
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).ok).toBe(true);
  });

  it('returns 503 when lock is held by concurrent request', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 10000 });

    let releaseBarrier: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    const app = express();
    app.get('/api/locked', tslock(), (_req, res) => {
      barrier.then(() => res.json({ ok: true }));
    });

    server = await startServer(app);

    const firstReq = makeRequest('/api/locked');
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await makeRequest('/api/locked');
    expect(res2.status).toBe(503);
    expect(res2.headers['retry-after']).toBeDefined();
    expect(res2.headers['lock-name']).toBeDefined();

    releaseBarrier!();
    const res1 = await firstReq;
    expect(res1.status).toBe(200);
  });

  it('re-acquires lock after first handler completes', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 5000, lockAtLeastFor: 0 });
    const app = express();
    app.get('/api/locked', tslock(), (_req, res) => {
      res.json({ ok: true });
    });

    server = await startServer(app);

    const res1 = await makeRequest('/api/locked');
    expect(res1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    const res2 = await makeRequest('/api/locked');
    expect(res2.status).toBe(200);
  });

  it('different HTTP methods use different lock names', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 10000 });
    const app = express();
    app.get('/api/locked', tslock(), (_req, res) => res.json({ method: 'get' }));
    app.post('/api/locked', tslock(), (_req, res) => res.json({ method: 'post' }));

    server = await startServer(app);
    const [getRes, postRes] = await Promise.all([
      makeRequest('/api/locked', 'GET'),
      makeRequest('/api/locked', 'POST'),
    ]);
    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
  });

  it('custom lockedStatus returns custom status code', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 10000, defaultLockedStatus: 423 });

    let releaseBarrier: () => void;
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });

    const app = express();
    app.get('/api/locked', tslock(), (_req, res) => {
      barrier.then(() => res.json({ ok: true }));
    });

    server = await startServer(app);

    const firstReq = makeRequest('/api/locked');
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await makeRequest('/api/locked');
    expect(res2.status).toBe(423);

    releaseBarrier!();
    await firstReq;
  });

  it('handler error returns 500 and lock is released', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 5000, lockAtLeastFor: 0 });
    const app = express();
    app.get('/api/locked', tslock(), () => {
      throw new Error('handler crash');
    });
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    server = await startServer(app);
    const res1 = await makeRequest('/api/locked');
    expect(res1.status).toBe(500);
    await new Promise((r) => setTimeout(r, 200));
    const res2 = await makeRequest('/api/locked');
    expect(res2.status).toBe(500);
  });

  it('LockAssert.assertLocked works inside handler', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({ lockProvider: provider, lockAtMostFor: 10000 });
    const app = express();
    app.get('/api/locked', tslock(), (_req, res) => {
      LockAssert.assertLocked();
      res.json({ assertion: 'success' });
    });

    server = await startServer(app);
    const res = await makeRequest('/api/locked');
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).assertion).toBe('success');
  });

  it('reentrancy: nested middleware with same lock name executes handler', async () => {
    const provider = new InMemoryLockProvider();
    const tslock = createExpressLock({
      lockProvider: provider,
      lockAtMostFor: 10000,
      lockNamePrefix: 'reentrancy-test',
    });
    const app = express();
    let handlerCalls = 0;
    app.use('/api', tslock(), tslock(), (_req, res) => {
      handlerCalls++;
      res.json({ called: handlerCalls });
    });

    server = await startServer(app);
    const res = await makeRequest('/api');
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });
});
