import {
  type DurationInput,
  type LockingTaskExecutor,
  type SimpleLock,
  createLockConfig,
  parseDuration,
} from '@tslock/core';
import {
  type JobLockOptions,
  type ResolvedSchedulerLockConfig,
  type SchedulerLockConfig,
  createSchedulerLock,
} from '@tslock/scheduler-core';

export interface NodeCronRunCoordinator {
  shouldRun(key: string, ttlMs: number): boolean | Promise<boolean>;
  onComplete?(key: string): void | Promise<void>;
}

export interface NodeCronScheduleApi {
  schedule(expression: string, func: (...args: unknown[]) => unknown, options?: Record<string, unknown>): unknown;
}

export interface NodeCronLock {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrap<TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult | Promise<TResult>,
    job: JobLockOptions,
  ): (...args: TArgs) => Promise<TResult | undefined>;
  schedule(
    cron: NodeCronScheduleApi,
    expression: string,
    task: (...args: unknown[]) => unknown,
    job: JobLockOptions & { taskOptions?: Record<string, unknown> },
  ): unknown;
  createRunCoordinator(options?: {
    lockAtLeastFor?: DurationInput;
    keyPrefix?: string;
  }): NodeCronRunCoordinator;
}

export function createNodeCronLock(input: SchedulerLockConfig): NodeCronLock {
  const lifecycle = createSchedulerLock(input);

  return {
    config: lifecycle.config,
    executor: lifecycle.executor,
    wrap: lifecycle.wrap.bind(lifecycle),
    schedule(cron, expression, task, job) {
      const { taskOptions, ...lockJob } = job;
      return cron.schedule(expression, lifecycle.wrap(task, lockJob), taskOptions);
    },
    createRunCoordinator(options = {}) {
      return createTslockRunCoordinator(lifecycle.config.lockProvider, options);
    },
  };
}

function createTslockRunCoordinator(
  lockProvider: { lock: (config: ReturnType<typeof createLockConfig>) => Promise<SimpleLock | undefined> },
  options: { lockAtLeastFor?: DurationInput; keyPrefix?: string },
): NodeCronRunCoordinator {
  const locks = new Map<string, SimpleLock>();
  const lockAtLeastFor = parseDuration(options.lockAtLeastFor ?? 0);
  const keyPrefix = options.keyPrefix ?? '';

  return {
    async shouldRun(key, ttlMs) {
      const lockName = `${keyPrefix}${key}`;
      const lock = await lockProvider.lock(createLockConfig(lockName, ttlMs, lockAtLeastFor));
      if (!lock) return false;
      locks.set(lockName, lock);
      return true;
    },
    async onComplete(key) {
      const lockName = `${keyPrefix}${key}`;
      const lock = locks.get(lockName);
      if (!lock) return;
      try {
        await lock.unlock();
      } finally {
        locks.delete(lockName);
      }
    },
  };
}
