import type { LockConfiguration } from './lock-configuration.js';

export interface LockingTaskExecutorListener {
  onLockAttempt(config: LockConfiguration): void;
  onLockAcquired(config: LockConfiguration): void;
  onLockNotAcquired(config: LockConfiguration): void;
  onTaskStarted(config: LockConfiguration): void;
  onTaskFinished(config: LockConfiguration, executionTimeMillis: number): void;
}

export const NO_OP_LISTENER: LockingTaskExecutorListener = {
  onLockAttempt: () => {},
  onLockAcquired: () => {},
  onLockNotAcquired: () => {},
  onTaskStarted: () => {},
  onTaskFinished: () => {},
};
