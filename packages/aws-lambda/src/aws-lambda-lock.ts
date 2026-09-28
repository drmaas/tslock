import type { LockingTaskExecutor } from '@tslock/core';
import {
  type JobLockOptions,
  type ResolvedSchedulerLockConfig,
  type SchedulerLockConfig,
  createSchedulerLock,
} from '@tslock/scheduler-core';

export type AwsLambdaHandler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  context: unknown,
  callback?: unknown,
) => TResult | Promise<TResult>;

export interface AwsLambdaLock {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrapHandler<TEvent = unknown, TResult = unknown>(
    handler: AwsLambdaHandler<TEvent, TResult>,
    job: JobLockOptions,
  ): AwsLambdaHandler<TEvent, TResult | undefined>;
}

export function createAwsLambdaLock(input: SchedulerLockConfig): AwsLambdaLock {
  const lifecycle = createSchedulerLock(input);
  return {
    config: lifecycle.config,
    executor: lifecycle.executor,
    wrapHandler<TEvent = unknown, TResult = unknown>(
      handler: AwsLambdaHandler<TEvent, TResult>,
      job: JobLockOptions,
    ): AwsLambdaHandler<TEvent, TResult | undefined> {
      return lifecycle.wrap(handler, job);
    },
  };
}
