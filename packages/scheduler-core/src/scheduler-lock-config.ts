import {
  type DurationInput,
  LockException,
  type LockingTaskExecutorListener,
  type LockProvider,
  parseDuration,
  Utils,
} from '@tslock/core';

export interface SchedulerLockConfig {
  lockProvider: LockProvider;
  defaultLockAtMostFor: DurationInput;
  defaultLockAtLeastFor?: DurationInput;
  listener?: LockingTaskExecutorListener;
}

export interface ResolvedSchedulerLockConfig {
  readonly lockProvider: LockProvider;
  readonly listener?: LockingTaskExecutorListener;
  readonly defaultLockAtMostFor: number;
  readonly defaultLockAtLeastFor: number;
}

export interface JobLockOptions {
  name: string;
  lockAtMostFor?: DurationInput;
  lockAtLeastFor?: DurationInput;
}

export function resolveSchedulerLockConfig(input: SchedulerLockConfig): ResolvedSchedulerLockConfig {
  if (input === null || typeof input !== 'object' || typeof input.lockProvider?.lock !== 'function') {
    throw new LockException('Scheduler lockProvider is required');
  }
  if (input.defaultLockAtMostFor === undefined) {
    throw new LockException('defaultLockAtMostFor is required');
  }
  const defaultLockAtMostFor = parseDuration(input.defaultLockAtMostFor);
  const defaultLockAtLeastFor = parseDuration(input.defaultLockAtLeastFor ?? 0);
  if (defaultLockAtLeastFor > defaultLockAtMostFor) {
    throw new LockException('defaultLockAtLeastFor must be <= defaultLockAtMostFor');
  }
  return {
    lockProvider: input.lockProvider,
    listener: input.listener,
    defaultLockAtMostFor,
    defaultLockAtLeastFor,
  };
}

export function validateJobLockOptions(job: JobLockOptions): void {
  if (job === null || typeof job !== 'object') {
    throw new LockException('Job lock options are required');
  }
  if (typeof job.name !== 'string' || job.name.length === 0) {
    throw new LockException('Job lock name must be a non-empty string');
  }
  Utils.validateLockName(job.name);
  const most = job.lockAtMostFor === undefined ? undefined : parseDuration(job.lockAtMostFor);
  const least = job.lockAtLeastFor === undefined ? undefined : parseDuration(job.lockAtLeastFor);
  if (most !== undefined && least !== undefined && least > most) {
    throw new LockException('lockAtLeastFor must be <= lockAtMostFor');
  }
}
