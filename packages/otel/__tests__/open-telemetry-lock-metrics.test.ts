import type { Attributes, Meter } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import {
  DefaultLockingTaskExecutor,
  type ExtensibleLockProvider,
  KeepAliveLockProvider,
  LockExtender,
  type Scheduler,
  createLockConfig,
} from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { describe, expect, it, vi } from 'vitest';
import { TSLOCK_METRIC_ATTRIBUTES, TSLOCK_METRIC_NAMES, createOpenTelemetryLockMetrics } from '../src/index.js';

class CollectingReader extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeScheduler implements Scheduler {
  callbacks: Array<() => void> = [];

  setInterval(callback: () => void): { clear(): void } {
    this.callbacks.push(callback);
    return {
      clear: () => {
        this.callbacks = this.callbacks.filter((candidate) => candidate !== callback);
      },
    };
  }
}

function setup() {
  const reader = new CollectingReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  const meter = meterProvider.getMeter('test');
  const metrics = createOpenTelemetryLockMetrics({ meter });
  return { reader, metrics };
}

async function points(reader: CollectingReader, name: string) {
  const { resourceMetrics, errors } = await reader.collect();
  expect(errors).toEqual([]);
  const metric = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((item) => item.descriptor.name === name);
  return metric?.dataPoints ?? [];
}

function attributeValue(attributes: Attributes, key: string): unknown {
  return attributes[key];
}

function sumMatching(
  dataPoints: ReadonlyArray<{ value: unknown; attributes: Attributes }>,
  expected: Attributes,
): number {
  return dataPoints
    .filter((point) =>
      Object.entries(expected).every(([key, value]) => attributeValue(point.attributes, key) === value),
    )
    .reduce((total, point) => total + Number(point.value), 0);
}

function histogramMatching(
  dataPoints: ReadonlyArray<{ value: unknown; attributes: Attributes }>,
  expected: Attributes,
): { count: number; sum: number } {
  const matches = dataPoints.filter((point) =>
    Object.entries(expected).every(([key, value]) => attributeValue(point.attributes, key) === value),
  );
  return matches.reduce<{ count: number; sum: number }>(
    (total, point) => {
      const value = point.value as { count?: number; sum?: number };
      return { count: total.count + (value.count ?? 0), sum: total.sum + (value.sum ?? 0) };
    },
    { count: 0, sum: 0 },
  );
}

describe('createOpenTelemetryLockMetrics', () => {
  it('records acquire, skip, task duration, active tasks, and unlock', async () => {
    const { reader, metrics } = setup();
    const storage = new InMemoryLockProvider();
    const executor = new DefaultLockingTaskExecutor(metrics.instrument(storage), metrics.listener);
    const config = createLockConfig('nightly-cleanup', 60_000, 1_000);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = executor.executeWithLock(async () => {
      await gate;
    }, config);
    await vi.waitFor(() => expect(storage.isLocked('nightly-cleanup')).toBe(true));

    const skipped = await executor.executeWithLock(async () => 'skipped', config);
    expect(skipped.wasExecuted).toBe(false);

    release();
    const result = await running;
    expect(result.wasExecuted).toBe(true);

    const lease = {
      [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'nightly-cleanup',
      [TSLOCK_METRIC_ATTRIBUTES.lockAtMostForMs]: 60_000,
      [TSLOCK_METRIC_ATTRIBUTES.lockAtLeastForMs]: 1_000,
    };
    expect(sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockAttempt), lease)).toBe(2);
    expect(sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockAcquired), lease)).toBe(1);
    expect(sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockSkipped), lease)).toBe(1);
    expect(sumMatching(await points(reader, TSLOCK_METRIC_NAMES.taskActive), lease)).toBe(0);
    const duration = histogramMatching(await points(reader, TSLOCK_METRIC_NAMES.taskDuration), lease);
    expect(duration.count).toBe(1);
    expect(duration.sum).toBeGreaterThanOrEqual(0);
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockUnlocked), {
        ...lease,
        [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'success',
      }),
    ).toBe(1);
    const unlockDuration = histogramMatching(await points(reader, TSLOCK_METRIC_NAMES.lockUnlockDuration), {
      ...lease,
      [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'success',
    });
    expect(unlockDuration.count).toBe(1);
    expect(unlockDuration.sum).toBeGreaterThanOrEqual(0);
  });

  it('records extend success with the requested durations', async () => {
    const { reader, metrics } = setup();
    const executor = new DefaultLockingTaskExecutor(metrics.instrument(new InMemoryLockProvider()), metrics.listener);
    await executor.executeWithLock(
      async () => {
        await LockExtender.extendActiveLock(120_000, 5_000);
      },
      createLockConfig('long-task', 60_000),
    );

    const requested = {
      [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'long-task',
      [TSLOCK_METRIC_ATTRIBUTES.lockAtMostForMs]: 120_000,
      [TSLOCK_METRIC_ATTRIBUTES.lockAtLeastForMs]: 5_000,
      [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'success',
    };
    expect(sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockExtend), requested)).toBe(1);
    expect(histogramMatching(await points(reader, TSLOCK_METRIC_NAMES.lockExtendDuration), requested).count).toBe(1);
  });

  it('records extend returning undefined as NotExtended and rethrows extend errors', async () => {
    const { reader, metrics } = setup();
    const missing: ExtensibleLockProvider = {
      async lock() {
        return {
          unlock: async () => {},
          extend: async () => undefined,
        };
      },
    };
    const executor = new DefaultLockingTaskExecutor(metrics.instrument(missing), metrics.listener);
    await expect(
      executor.executeWithLock(
        async () => {
          await LockExtender.extendActiveLock(60_000, 0);
        },
        createLockConfig('missing', 60_000),
      ),
    ).rejects.toThrow();

    const notExtended = {
      [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'missing',
      [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'failure',
      [TSLOCK_METRIC_ATTRIBUTES.errorType]: 'NotExtended',
    };
    expect(sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockExtend), notExtended)).toBe(1);

    const boom = new Error('extend-boom');
    boom.name = 'ExtendBoom';
    const throwing: ExtensibleLockProvider = {
      async lock() {
        return {
          unlock: async () => {},
          extend: async () => {
            throw boom;
          },
        };
      },
    };
    const throwingExecutor = new DefaultLockingTaskExecutor(metrics.instrument(throwing), metrics.listener);
    await expect(
      throwingExecutor.executeWithLock(
        async () => {
          await LockExtender.extendActiveLock(60_000, 0);
        },
        createLockConfig('throwing', 60_000),
      ),
    ).rejects.toBe(boom);
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockExtend), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'throwing',
        [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'failure',
        [TSLOCK_METRIC_ATTRIBUTES.errorType]: 'ExtendBoom',
      }),
    ).toBe(1);
  });

  it('records unlock failure and preserves the task result', async () => {
    const { reader, metrics } = setup();
    const failure = new Error('unlock-boom');
    failure.name = 'UnlockBoom';
    const provider: ExtensibleLockProvider = {
      async lock() {
        return {
          unlock: async () => {
            throw failure;
          },
          extend: async () => undefined,
        };
      },
    };
    const executor = new DefaultLockingTaskExecutor(metrics.instrument(provider), metrics.listener);
    const result = await executor.executeWithLock(async () => 'done', createLockConfig('held', 30_000, 250));
    expect(result.wasExecuted).toBe(true);
    expect(result.getResult()).toBe('done');
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockUnlocked), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'held',
        [TSLOCK_METRIC_ATTRIBUTES.lockAtMostForMs]: 30_000,
        [TSLOCK_METRIC_ATTRIBUTES.lockAtLeastForMs]: 250,
        [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'failure',
        [TSLOCK_METRIC_ATTRIBUTES.errorType]: 'UnlockBoom',
      }),
    ).toBe(1);
  });

  it('records keep-alive loss and successful renewal separately from extend', async () => {
    const { reader, metrics } = setup();
    const scheduler = new FakeScheduler();
    const renewed = { unlock: vi.fn(), extend: vi.fn().mockResolvedValue(undefined) };
    const extend = vi.fn().mockResolvedValue(renewed);
    const storage: ExtensibleLockProvider = {
      async lock() {
        return { unlock: vi.fn(), extend };
      },
    };
    const provider = new KeepAliveLockProvider(metrics.instrument(storage), scheduler, metrics.onKeepAliveFailure);
    const lock = await provider.lock(createLockConfig('keepalive', 30_000));
    expect(lock).toBeDefined();

    const renew = scheduler.callbacks[0];
    expect(renew).toBeDefined();
    await Promise.resolve(renew?.());
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockExtend), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'keepalive',
        [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'success',
      }),
    ).toBe(1);
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.keepAliveFailure), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'keepalive',
      }),
    ).toBe(0);

    await Promise.resolve(renew?.());
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockExtend), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'keepalive',
        [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'failure',
        [TSLOCK_METRIC_ATTRIBUTES.errorType]: 'NotExtended',
      }),
    ).toBe(1);
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.keepAliveFailure), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'keepalive',
        [TSLOCK_METRIC_ATTRIBUTES.errorType]: 'LockException',
      }),
    ).toBe(1);
    expect(scheduler.callbacks).toHaveLength(0);
  });

  it('decrements active tasks when the duration histogram throws', async () => {
    const active = vi.fn();
    const meter = {
      createCounter: () => ({ add() {} }),
      createHistogram: () => ({
        record() {
          throw new Error('histogram');
        },
      }),
      createUpDownCounter: () => ({ add: active }),
    } as unknown as Meter;
    const metrics = createOpenTelemetryLockMetrics({ meter });
    const executor = new DefaultLockingTaskExecutor(
      metrics.instrument({
        async lock() {
          return { unlock: async () => {}, extend: async () => undefined };
        },
      }),
      metrics.listener,
    );
    const result = await executor.executeWithLock(async () => 'ok', createLockConfig('active', 1_000));
    expect(result.getResult()).toBe('ok');
    expect(active).toHaveBeenCalledTimes(2);
    expect(active.mock.calls[0]?.[0]).toBe(1);
    expect(active.mock.calls[1]?.[0]).toBe(-1);
  });

  it('does not let a throwing meter fail unlock', async () => {
    const meter = {
      createCounter: () => ({
        add: () => {
          throw new Error('metric');
        },
      }),
      createHistogram: () => ({
        record: () => {
          throw new Error('metric');
        },
      }),
      createUpDownCounter: () => ({
        add: () => {
          throw new Error('metric');
        },
      }),
    } as unknown as Meter;
    const metrics = createOpenTelemetryLockMetrics({ meter });
    const unlock = vi.fn();
    const provider = metrics.instrument({
      async lock() {
        return { unlock, extend: async () => undefined };
      },
    });
    const lock = await provider.lock(createLockConfig('safe', 1_000));
    await expect(lock?.unlock()).resolves.toBeUndefined();
    expect(unlock).toHaveBeenCalledOnce();
  });

  it('returns the same provider when instrument is called twice', async () => {
    const { reader, metrics } = setup();
    const storage = new InMemoryLockProvider();
    const once = metrics.instrument(storage);
    expect(metrics.instrument(once)).toBe(once);
    const executor = new DefaultLockingTaskExecutor(once, metrics.listener);
    await executor.executeWithLock(async () => {}, createLockConfig('once', 1_000));
    expect(
      sumMatching(await points(reader, TSLOCK_METRIC_NAMES.lockUnlocked), {
        [TSLOCK_METRIC_ATTRIBUTES.lockName]: 'once',
        [TSLOCK_METRIC_ATTRIBUTES.outcome]: 'success',
      }),
    ).toBe(1);
  });
});
