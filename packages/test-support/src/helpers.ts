import { randomUUID } from 'node:crypto';
import {
  createLockConfig,
  parseDuration,
  type LockConfiguration,
  type LockProvider,
} from '@tslock/core';

export function config(
  name: string,
  lockAtMostFor: string | number,
  lockAtLeastFor?: string | number,
): LockConfiguration {
  return createLockConfig(
    name,
    parseDuration(lockAtMostFor),
    lockAtLeastFor !== undefined ? parseDuration(lockAtLeastFor) : 0,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cleanupLock(provider: LockProvider, name: string): Promise<void> {
  try {
    const lock = await provider.lock(config(name, '1s', 0));
    if (lock) {
      await lock.unlock();
    }
  } catch {
  }
}

export function uniqueLockName(prefix = 'lock'): string {
  return `${prefix}-${randomUUID()}`;
}
