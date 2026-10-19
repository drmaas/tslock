import { describe, expect, it, vi } from 'vitest';
import { createLockConfig, type LockConfiguration } from '../src/lock-configuration.js';
import { LockCanNotBeExtendedException, LockException } from '../src/lock-exception.js';
import { LockExtender } from '../src/lock-extender.js';
import type { LockProvider } from '../src/lock-provider.js';
import { DefaultLockingTaskExecutor } from '../src/locking-task-executor.js';
import { type LockingTaskExecutorListener, NO_OP_LISTENER } from '../src/locking-task-executor-listener.js';
import { AbstractSimpleLock, type SimpleLock } from '../src/simple-lock.js';

function makeMockProvider(returnUndefined = false): {
  provider: LockProvider;
  unlockMock: ReturnType<typeof vi.fn>;
  extendMock: ReturnType<typeof vi.fn>;
} {
  const unlockMock = vi.fn();
  const extendMock = vi.fn();
  const lock: SimpleLock = { unlock: unlockMock, extend: extendMock };
  const provider: LockProvider = {
    lock: vi.fn().mockImplementation(() => (returnUndefined ? undefined : Promise.resolve(lock))),
  };
  return { provider, unlockMock, extendMock };
}

class RecordingLock extends AbstractSimpleLock {
  readonly released = vi.fn();

  constructor(
    config: LockConfiguration,
    private readonly successor?: SimpleLock,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    this.released();
  }

  protected override async doExtend(): Promise<SimpleLock | undefined> {
    return this.successor;
  }
}

describe('DefaultLockingTaskExecutor', () => {
  it('runs task when lock acquired', async () => {
    const { provider, unlockMock } = makeMockProvider();
    const executor = new DefaultLockingTaskExecutor(provider);
    const task = vi.fn().mockResolvedValue(42);
    const result = await executor.executeWithLock(task, createLockConfig('t', 1000));
    expect(result.wasExecuted).toBe(true);
    expect(result.getResult()).toBe(42);
    expect(task).toHaveBeenCalledOnce();
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('skips task when lock not acquired', async () => {
    const { provider, unlockMock } = makeMockProvider(true);
    const executor = new DefaultLockingTaskExecutor(provider);
    const task = vi.fn();
    const result = await executor.executeWithLock(task, createLockConfig('t', 1000));
    expect(result.wasExecuted).toBe(false);
    expect(result.getResult()).toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    expect(unlockMock).not.toHaveBeenCalled();
  });

  it('releases lock when task throws', async () => {
    const { provider, unlockMock } = makeMockProvider();
    const executor = new DefaultLockingTaskExecutor(provider);
    const task = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(executor.executeWithLock(task, createLockConfig('t', 1000))).rejects.toThrow('boom');
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('reentrant: runs task without acquiring lock', async () => {
    const { provider } = makeMockProvider();
    const executor = new DefaultLockingTaskExecutor(provider);
    const task = vi.fn().mockResolvedValue('ok');
    const outerResult = await executor.executeWithLock(
      async () => {
        return executor.executeWithLock(task, createLockConfig('t', 1000));
      },
      createLockConfig('t', 1000),
    );
    expect(outerResult.wasExecuted).toBe(true);
    expect(task).toHaveBeenCalledOnce();
  });

  it('listener events fire in order on success', async () => {
    const events: string[] = [];
    const listener: LockingTaskExecutorListener = {
      onLockAttempt: () => events.push('attempt'),
      onLockAcquired: () => events.push('acquired'),
      onLockNotAcquired: () => events.push('notAcquired'),
      onTaskStarted: () => events.push('started'),
      onTaskFinished: () => events.push('finished'),
    };
    const { provider } = makeMockProvider();
    const executor = new DefaultLockingTaskExecutor(provider, listener);
    await executor.executeWithLock(async () => {}, createLockConfig('t', 1000));
    expect(events).toEqual(['attempt', 'acquired', 'started', 'finished']);
  });

  it('listener exception does not block task or unlock', async () => {
    const { provider, unlockMock } = makeMockProvider();
    const listener: LockingTaskExecutorListener = {
      onLockAttempt: () => {
        throw new Error('listener-boom');
      },
      onLockAcquired: () => {
        throw new Error('listener-boom');
      },
      onLockNotAcquired: NO_OP_LISTENER.onLockNotAcquired,
      onTaskStarted: () => {
        throw new Error('listener-boom');
      },
      onTaskFinished: NO_OP_LISTENER.onTaskFinished,
    };
    const executor = new DefaultLockingTaskExecutor(provider, listener);
    const task = vi.fn().mockResolvedValue(1);
    const result = await executor.executeWithLock(task, createLockConfig('t', 1000));
    expect(result.wasExecuted).toBe(true);
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('unlock error is swallowed', async () => {
    const { provider, unlockMock } = makeMockProvider();
    unlockMock.mockRejectedValue(new Error('unlock-boom'));
    const executor = new DefaultLockingTaskExecutor(provider);
    const result = await executor.executeWithLock(async () => 'x', createLockConfig('t', 1000));
    expect(result.wasExecuted).toBe(true);
  });

  it('unlock error invokes onUnlockError listener and preserves task result', async () => {
    const { provider, unlockMock } = makeMockProvider();
    unlockMock.mockRejectedValue(new Error('unlock-boom'));
    const onUnlockError = vi.fn();
    const listener: LockingTaskExecutorListener = {
      ...NO_OP_LISTENER,
      onUnlockError,
    };
    const executor = new DefaultLockingTaskExecutor(provider, listener);
    const result = await executor.executeWithLock(async () => 'x', createLockConfig('t', 1000));
    expect(result.wasExecuted).toBe(true);
    expect(result.getResult()).toBe('x');
    expect(onUnlockError).toHaveBeenCalledOnce();
    expect(onUnlockError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it('unlocks the successor after extendActiveLock and does not report an unlock error', async () => {
    const successor = new RecordingLock(createLockConfig('t', 60_000, 0));
    const original = new RecordingLock(createLockConfig('t', 5_000, 0), successor);
    const onUnlockError = vi.fn();
    const executor = new DefaultLockingTaskExecutor(
      { lock: async () => original },
      { ...NO_OP_LISTENER, onUnlockError },
    );
    const result = await executor.executeWithLock(
      async () => {
        await LockExtender.extendActiveLock(60_000, 0);
      },
      createLockConfig('t', 5_000, 0),
    );
    expect(result.wasExecuted).toBe(true);
    expect(successor.released).toHaveBeenCalledOnce();
    expect(original.released).not.toHaveBeenCalled();
    expect(onUnlockError).not.toHaveBeenCalled();
    await expect(original.unlock()).rejects.toThrow(LockException);
  });

  it('failed extend rejects and still unlocks the original handle', async () => {
    const original = new RecordingLock(createLockConfig('stuck', 5_000, 0));
    const onUnlockError = vi.fn();
    const executor = new DefaultLockingTaskExecutor(
      { lock: async () => original },
      { ...NO_OP_LISTENER, onUnlockError },
    );
    await expect(
      executor.executeWithLock(
        async () => {
          await LockExtender.extendActiveLock(60_000, 0);
        },
        createLockConfig('stuck', 5_000, 0),
      ),
    ).rejects.toThrow(LockCanNotBeExtendedException);
    expect(original.released).toHaveBeenCalledOnce();
    expect(onUnlockError).not.toHaveBeenCalled();
  });

  it('onUnlockError listener exception does not propagate', async () => {
    const { provider, unlockMock } = makeMockProvider();
    unlockMock.mockRejectedValue(new Error('unlock-boom'));
    const listener: LockingTaskExecutorListener = {
      ...NO_OP_LISTENER,
      onUnlockError: () => {
        throw new Error('listener-boom');
      },
    };
    const executor = new DefaultLockingTaskExecutor(provider, listener);
    const result = await executor.executeWithLock(async () => 'x', createLockConfig('t', 1000));
    expect(result.wasExecuted).toBe(true);
  });
});
