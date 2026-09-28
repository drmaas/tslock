import { LockException, type LockingTaskExecutor } from '@tslock/core';

export interface SchedulerLockRuntime {
  readonly executor: LockingTaskExecutor;
  readonly defaultLockAtMostFor: number;
  readonly defaultLockAtLeastFor: number;
}

let activeRuntime: SchedulerLockRuntime | undefined;

export function bindSchedulerLockRuntime(runtime: SchedulerLockRuntime): void {
  activeRuntime = runtime;
}

export function unbindSchedulerLockRuntime(runtime: SchedulerLockRuntime): void {
  if (activeRuntime === runtime) {
    activeRuntime = undefined;
  }
}

export function getSchedulerLockRuntime(): SchedulerLockRuntime {
  if (!activeRuntime) {
    throw new LockException(
      '@SchedulerLock requires TslockModule.forRoot() or TslockModule.forRootAsync() before the method runs',
    );
  }
  return activeRuntime;
}
