import { ClockProvider } from './clock-provider.js';
import { type DurationInput, parseDuration } from './duration.js';
import { LockException } from './lock-exception.js';

export interface LockConfiguration {
  readonly name: string;
  readonly lockAtMostFor: number;
  readonly lockAtLeastFor: number;
  readonly createdAt: number;
}

export function lockAtMostUntil(config: LockConfiguration): number {
  return config.createdAt + config.lockAtMostFor;
}

export function lockAtLeastUntil(config: LockConfiguration): number {
  return config.createdAt + config.lockAtLeastFor;
}

export function unlockTime(config: LockConfiguration): number {
  return Math.max(ClockProvider.now(), lockAtLeastUntil(config));
}

export function createLockConfig(
  name: string,
  lockAtMostFor: DurationInput,
  lockAtLeastFor: DurationInput = 0,
): LockConfiguration {
  if (typeof name !== 'string' || name.length === 0) {
    throw new LockException('Lock name must be a non-empty string');
  }
  const most = parseDuration(lockAtMostFor);
  const least = parseDuration(lockAtLeastFor);
  if (most < 0) {
    throw new LockException('lockAtMostFor must be >= 0');
  }
  if (least < 0) {
    throw new LockException('lockAtLeastFor must be >= 0');
  }
  if (least > most) {
    throw new LockException('lockAtLeastFor must be <= lockAtMostFor');
  }
  return {
    name,
    lockAtMostFor: most,
    lockAtLeastFor: least,
    createdAt: ClockProvider.now(),
  };
}
