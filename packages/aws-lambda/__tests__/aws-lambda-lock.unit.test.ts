import type { LockProvider, SimpleLock } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { createAwsLambdaLock } from '../src/index.js';

function acquiredLock(onUnlock?: () => void): SimpleLock {
  return {
    async unlock() {
      onUnlock?.();
    },
    async extend() {
      return undefined;
    },
  };
}

function provider(acquire = true, onUnlock?: () => void): LockProvider {
  return {
    async lock() {
      return acquire ? acquiredLock(onUnlock) : undefined;
    },
  };
}

describe('createAwsLambdaLock', () => {
  it('runs the handler with event and context when the lock is acquired', async () => {
    const lock = createAwsLambdaLock({
      lockProvider: provider(true),
      defaultLockAtMostFor: '1m',
    });
    const handler = lock.wrapHandler(
      async (event: { id: string }, context: unknown) => {
        return `${event.id}:${(context as { awsRequestId: string }).awsRequestId}`;
      },
      { name: 'scheduled', lockAtMostFor: '30s' },
    );

    await expect(handler({ id: 'e1' }, { awsRequestId: 'r1' })).resolves.toBe('e1:r1');
  });

  it('skips the handler when the lock is not acquired', async () => {
    let calls = 0;
    const lock = createAwsLambdaLock({
      lockProvider: provider(false),
      defaultLockAtMostFor: '1m',
    });
    const handler = lock.wrapHandler(
      async () => {
        calls += 1;
        return { ok: true };
      },
      { name: 'scheduled', lockAtMostFor: '30s' },
    );

    await expect(handler({}, {})).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('unlocks after the handler throws', async () => {
    const events: string[] = [];
    const lock = createAwsLambdaLock({
      lockProvider: {
        async lock() {
          events.push('lock');
          return acquiredLock(() => events.push('unlock'));
        },
      },
      defaultLockAtMostFor: '1m',
    });
    const handler = lock.wrapHandler(
      async () => {
        throw new Error('handler failed');
      },
      { name: 'boom', lockAtMostFor: '1s' },
    );

    await expect(handler({}, {})).rejects.toThrow('handler failed');
    expect(events).toEqual(['lock', 'unlock']);
  });
});
