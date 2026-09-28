import { type Attributes, type Meter, ValueType, metrics } from '@opentelemetry/api';
import type { LockConfiguration, LockProvider, LockingTaskExecutorListener, SimpleLock } from '@tslock/core';

export const TSLOCK_METRIC_NAMES = Object.freeze({
  lockAttempt: 'tslock.lock.attempt',
  lockAcquired: 'tslock.lock.acquired',
  lockSkipped: 'tslock.lock.skipped',
  lockUnlocked: 'tslock.lock.unlocked',
  lockUnlockDuration: 'tslock.lock.unlock.duration',
  lockExtend: 'tslock.lock.extend',
  lockExtendDuration: 'tslock.lock.extend.duration',
  keepAliveFailure: 'tslock.lock.keepalive.failure',
  taskDuration: 'tslock.task.duration',
  taskActive: 'tslock.task.active',
});

export const TSLOCK_METRIC_ATTRIBUTES = Object.freeze({
  lockName: 'lock.name',
  lockAtMostForMs: 'lock.at_most_for_ms',
  lockAtLeastForMs: 'lock.at_least_for_ms',
  outcome: 'outcome',
  errorType: 'error.type',
});

const EXTEND_NOT_EXTENDED = 'NotExtended';

const OUTCOME_SUCCESS = 'success';
const OUTCOME_FAILURE = 'failure';
const DURATION_BOUNDARIES = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000];
const INSTRUMENTED = Symbol('@tslock/otel.instrumented-lock-provider');

export interface OpenTelemetryLockMetricsOptions {
  readonly meter?: Meter;
}

export interface OpenTelemetryLockMetrics {
  readonly listener: LockingTaskExecutorListener;
  onKeepAliveFailure(config: LockConfiguration, error: unknown): void;
  instrument(provider: LockProvider): LockProvider;
}

function record(emit: () => void): void {
  try {
    emit();
  } catch {}
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return 'Error';
}

function lockAttributes(config: LockConfiguration, extra?: Attributes): Attributes {
  return {
    [TSLOCK_METRIC_ATTRIBUTES.lockName]: config.name,
    [TSLOCK_METRIC_ATTRIBUTES.lockAtMostForMs]: config.lockAtMostFor,
    [TSLOCK_METRIC_ATTRIBUTES.lockAtLeastForMs]: config.lockAtLeastFor,
    ...extra,
  };
}

function outcomeAttributes(config: LockConfiguration, outcome: string, failure: unknown): Attributes {
  const attributes = lockAttributes(config, { [TSLOCK_METRIC_ATTRIBUTES.outcome]: outcome });
  if (outcome === OUTCOME_FAILURE) {
    attributes[TSLOCK_METRIC_ATTRIBUTES.errorType] =
      failure === EXTEND_NOT_EXTENDED ? EXTEND_NOT_EXTENDED : errorType(failure);
  }
  return attributes;
}

class ObservedSimpleLock implements SimpleLock {
  constructor(
    private readonly delegate: SimpleLock,
    private readonly config: LockConfiguration,
    private readonly instruments: LockInstruments,
  ) {}

  async unlock(): Promise<void> {
    const start = performance.now();
    let failed = false;
    let failure: unknown;
    try {
      await this.delegate.unlock();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      const duration = performance.now() - start;
      const outcome = failed ? OUTCOME_FAILURE : OUTCOME_SUCCESS;
      const attributes = outcomeAttributes(this.config, outcome, failure);
      record(() => {
        this.instruments.unlocked.add(1, attributes);
        this.instruments.unlockDuration.record(duration, attributes);
      });
    }
  }

  async extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined> {
    const start = performance.now();
    const requested: LockConfiguration = {
      name: this.config.name,
      lockAtMostFor,
      lockAtLeastFor,
      createdAt: this.config.createdAt,
    };
    let failed = false;
    let failure: unknown;
    try {
      const next = await this.delegate.extend(lockAtMostFor, lockAtLeastFor);
      if (!next) {
        failed = true;
        failure = EXTEND_NOT_EXTENDED;
        return undefined;
      }
      return new ObservedSimpleLock(next, requested, this.instruments);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      const duration = performance.now() - start;
      const outcome = failed ? OUTCOME_FAILURE : OUTCOME_SUCCESS;
      const attributes = outcomeAttributes(requested, outcome, failure);
      record(() => {
        this.instruments.extend.add(1, attributes);
        this.instruments.extendDuration.record(duration, attributes);
      });
    }
  }
}

interface LockInstruments {
  unlocked: ReturnType<Meter['createCounter']>;
  unlockDuration: ReturnType<Meter['createHistogram']>;
  extend: ReturnType<Meter['createCounter']>;
  extendDuration: ReturnType<Meter['createHistogram']>;
}

export function createOpenTelemetryLockMetrics(
  options: OpenTelemetryLockMetricsOptions = {},
): OpenTelemetryLockMetrics {
  const meter = options.meter ?? metrics.getMeter('@tslock/otel');
  const durationAdvice = { explicitBucketBoundaries: DURATION_BOUNDARIES };
  const attempts = meter.createCounter(TSLOCK_METRIC_NAMES.lockAttempt, {
    description: 'Lock acquisition attempts',
    unit: '{attempt}',
  });
  const acquired = meter.createCounter(TSLOCK_METRIC_NAMES.lockAcquired, {
    description: 'Locks acquired',
    unit: '{lock}',
  });
  const skipped = meter.createCounter(TSLOCK_METRIC_NAMES.lockSkipped, {
    description: 'Locks skipped because they were held elsewhere',
    unit: '{lock}',
  });
  const unlocked = meter.createCounter(TSLOCK_METRIC_NAMES.lockUnlocked, {
    description: 'Lock unlock calls',
    unit: '{call}',
  });
  const unlockDuration = meter.createHistogram(TSLOCK_METRIC_NAMES.lockUnlockDuration, {
    description: 'Lock unlock call duration',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
    advice: durationAdvice,
  });
  const extend = meter.createCounter(TSLOCK_METRIC_NAMES.lockExtend, {
    description: 'Lock extend calls',
    unit: '{call}',
  });
  const extendDuration = meter.createHistogram(TSLOCK_METRIC_NAMES.lockExtendDuration, {
    description: 'Lock extend call duration',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
    advice: durationAdvice,
  });
  const keepAliveFailure = meter.createCounter(TSLOCK_METRIC_NAMES.keepAliveFailure, {
    description: 'Keep-alive renewals that stopped after the lock was lost or the retry failed',
    unit: '{failure}',
  });
  const taskDuration = meter.createHistogram(TSLOCK_METRIC_NAMES.taskDuration, {
    description: 'Locked task execution time',
    unit: 'ms',
    valueType: ValueType.DOUBLE,
    advice: durationAdvice,
  });
  const taskActive = meter.createUpDownCounter(TSLOCK_METRIC_NAMES.taskActive, {
    description: 'Tasks currently executing under a lock',
    unit: '{task}',
  });
  const instruments: LockInstruments = { unlocked, unlockDuration, extend, extendDuration };

  const listener: LockingTaskExecutorListener = {
    onLockAttempt(config) {
      record(() => attempts.add(1, lockAttributes(config)));
    },
    onLockAcquired(config) {
      record(() => acquired.add(1, lockAttributes(config)));
    },
    onLockNotAcquired(config) {
      record(() => skipped.add(1, lockAttributes(config)));
    },
    onTaskStarted(config) {
      record(() => taskActive.add(1, lockAttributes(config)));
    },
    onTaskFinished(config, executionTimeMillis) {
      record(() => {
        taskDuration.record(executionTimeMillis, lockAttributes(config));
        taskActive.add(-1, lockAttributes(config));
      });
    },
  };

  const onKeepAliveFailure = (config: LockConfiguration, error: unknown): void => {
    record(() => {
      keepAliveFailure.add(1, lockAttributes(config, { [TSLOCK_METRIC_ATTRIBUTES.errorType]: errorType(error) }));
    });
  };

  const instrument = (provider: LockProvider): LockProvider => {
    if (Object.hasOwn(provider, INSTRUMENTED)) return provider;
    const wrapped: LockProvider = {
      async lock(config) {
        const lock = await provider.lock(config);
        if (!lock) return undefined;
        return new ObservedSimpleLock(lock, config, instruments);
      },
    };
    Object.defineProperty(wrapped, INSTRUMENTED, { value: true });
    return wrapped;
  };

  return Object.freeze({ listener, onKeepAliveFailure, instrument });
}
