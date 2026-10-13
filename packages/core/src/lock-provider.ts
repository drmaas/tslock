import type { LockConfiguration } from './lock-configuration.js';
import type { SimpleLock } from './simple-lock.js';

export const extensibleLockProvider = Symbol('@tslock/core.extensibleLockProvider');

export interface LockProvider {
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

export interface ExtensibleLockProvider extends LockProvider {
  readonly [extensibleLockProvider]: true;
}
