import { performance } from 'node:perf_hooks';
import { DefaultLockingTaskExecutor, createLockConfig } from '../packages/core/dist/index.js';
import { InMemoryLockProvider } from '../packages/in-memory/dist/index.js';
import { createLockMiddlewareLifecycle, resolveMiddlewareConfig } from '../packages/middleware-core/dist/index.js';

const iterations = Number(process.env.TSLOCK_BENCH_ITERATIONS ?? 10_000);

async function measure(name, operation) {
  for (let index = 0; index < 1_000; index += 1) await operation();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await operation();
  const elapsed = performance.now() - started;
  const operationsPerSecond = (iterations / elapsed) * 1_000;
  console.log(`${name}: ${operationsPerSecond.toFixed(0)} ops/sec (${elapsed.toFixed(2)} ms)`);
}

const provider = new InMemoryLockProvider();
let sequence = 0;

await measure('in-memory lock/unlock', async () => {
  const lock = await provider.lock(createLockConfig(`bench-${sequence}`, '1m'));
  sequence += 1;
  await lock.unlock();
});

const executor = new DefaultLockingTaskExecutor(provider);
sequence = 0;
await measure('executor executeWithLock', async () => {
  await executor.executeWithLock(async () => undefined, createLockConfig(`executor-${sequence}`, '1m'));
  sequence += 1;
});

const lifecycle = createLockMiddlewareLifecycle(resolveMiddlewareConfig({ lockProvider: provider }));
sequence = 0;
await measure('middleware lifecycle request', async () => {
  await lifecycle.executeWithLock(
    { method: 'GET', path: `/bench/${sequence}` },
    undefined,
    async () => undefined,
    async () => undefined,
  );
  sequence += 1;
});
