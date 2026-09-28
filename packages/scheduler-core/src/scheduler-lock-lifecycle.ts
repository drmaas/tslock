import { DefaultLockingTaskExecutor, type LockingTaskExecutor, createLockConfig } from '@tslock/core';
import {
  type JobLockOptions,
  type ResolvedSchedulerLockConfig,
  type SchedulerLockConfig,
  resolveSchedulerLockConfig,
  validateJobLockOptions,
} from './scheduler-lock-config.js';

export interface SchedulerLockLifecycle {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrap<TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult | Promise<TResult>,
    job: JobLockOptions,
  ): (...args: TArgs) => Promise<TResult | undefined>;
  run<T>(task: () => Promise<T> | T, job: JobLockOptions): Promise<T | undefined>;
}

export function createSchedulerLock(input: SchedulerLockConfig): SchedulerLockLifecycle {
  const config = resolveSchedulerLockConfig(input);
  const executor = new DefaultLockingTaskExecutor(config.lockProvider, config.listener);

  const runUnderLock = async <T>(task: () => Promise<T> | T, job: JobLockOptions): Promise<T | undefined> => {
    const lockConfig = createLockConfig(
      job.name,
      job.lockAtMostFor ?? config.defaultLockAtMostFor,
      job.lockAtLeastFor ?? config.defaultLockAtLeastFor,
    );
    const result = await executor.executeWithLock(async () => task(), lockConfig);
    return result.wasExecuted ? result.getResult() : undefined;
  };

  return {
    config,
    executor,
    wrap<TArgs extends unknown[], TResult>(
      task: (...args: TArgs) => TResult | Promise<TResult>,
      job: JobLockOptions,
    ): (...args: TArgs) => Promise<TResult | undefined> {
      validateJobLockOptions(job);
      return (...args: TArgs) => runUnderLock(() => task(...args), job);
    },
    run<T>(task: () => Promise<T> | T, job: JobLockOptions): Promise<T | undefined> {
      validateJobLockOptions(job);
      return runUnderLock(task, job);
    },
  };
}
