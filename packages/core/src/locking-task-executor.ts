import { performance } from 'node:perf_hooks';
import { LockAssert } from './lock-assert.js';
import type { LockConfiguration } from './lock-configuration.js';
import { LockExtender } from './lock-extender.js';
import type { LockProvider } from './lock-provider.js';
import { type LockingTaskExecutorListener, NO_OP_LISTENER } from './locking-task-executor-listener.js';
import type { SimpleLock } from './simple-lock.js';

export interface TaskResult<T> {
  readonly wasExecuted: boolean;
  getResult(): T | undefined;
}

export namespace TaskResult {
  export function result<T>(value: T): TaskResult<T> {
    return {
      wasExecuted: true,
      getResult: () => value,
    };
  }

  export function notExecuted<T>(): TaskResult<T> {
    return {
      wasExecuted: false,
      getResult: () => undefined,
    };
  }
}

export interface LockingTaskExecutor {
  executeWithLock(task: () => Promise<void>, config: LockConfiguration): Promise<TaskResult<void>>;
  executeWithLock<T>(task: () => Promise<T>, config: LockConfiguration): Promise<TaskResult<T>>;
}

function safeEmit(emit: () => void): void {
  try {
    emit();
  } catch {}
}

async function executeTask<T>(
  task: () => Promise<T>,
  config: LockConfiguration,
  listener: LockingTaskExecutorListener,
): Promise<T | undefined> {
  safeEmit(() => listener.onTaskStarted(config));
  const start = performance.now();
  let result: T | undefined;
  try {
    result = await task();
  } finally {
    safeEmit(() => listener.onTaskFinished(config, performance.now() - start));
  }
  return result;
}

export class DefaultLockingTaskExecutor implements LockingTaskExecutor {
  constructor(
    private readonly lockProvider: LockProvider,
    private readonly listener: LockingTaskExecutorListener = NO_OP_LISTENER,
  ) {}

  async executeWithLock<T>(task: () => Promise<T>, config: LockConfiguration): Promise<TaskResult<T>> {
    if (LockAssert.alreadyLockedBy(config.name)) {
      const result = await executeTask(task, config, this.listener);
      return TaskResult.result(result as T);
    }

    safeEmit(() => this.listener.onLockAttempt(config));
    const lock = await this.lockProvider.lock(config);
    if (!lock) {
      safeEmit(() => this.listener.onLockNotAcquired(config));
      return TaskResult.notExecuted<T>();
    }
    safeEmit(() => this.listener.onLockAcquired(config));

    return this.runUnderLock(task, config, lock);
  }

  private async runUnderLock<T>(
    task: () => Promise<T>,
    config: LockConfiguration,
    lock: SimpleLock,
  ): Promise<TaskResult<T>> {
    const run = async (): Promise<TaskResult<T>> => {
      let result: T | undefined;
      try {
        result = await executeTask(task, config, this.listener);
      } finally {
        try {
          await lock.unlock();
        } catch {}
      }
      return TaskResult.result(result as T);
    };

    return (await LockAssert.runWithLock(config.name, async () =>
      LockExtender.runWithLock(lock, run),
    )) as TaskResult<T>;
  }
}
