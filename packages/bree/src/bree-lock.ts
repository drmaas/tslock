import type { LockingTaskExecutor } from '@tslock/core';
import {
  createSchedulerLock,
  type JobLockOptions,
  type ResolvedSchedulerLockConfig,
  type SchedulerLockConfig,
} from '@tslock/scheduler-core';

export interface BreeLock {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrap<TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult | Promise<TResult>,
    job: JobLockOptions,
  ): (...args: TArgs) => Promise<TResult | undefined>;
  run<T>(task: () => Promise<T> | T, job: JobLockOptions): Promise<T | undefined>;
}

export function createBreeLock(input: SchedulerLockConfig): BreeLock {
  const lifecycle = createSchedulerLock(input);
  return {
    config: lifecycle.config,
    executor: lifecycle.executor,
    wrap: lifecycle.wrap.bind(lifecycle),
    run: lifecycle.run.bind(lifecycle),
  };
}
