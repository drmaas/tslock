import type { LockConfiguration } from './lock-configuration.js';
import type { SimpleLock } from './simple-lock.js';

export interface SimpleLockWithConfiguration extends SimpleLock {
  getLockConfiguration(): LockConfiguration;
}
