import { ClockProvider } from './clock-provider.js';
import type { LockConfiguration } from './lock-configuration.js';
import { LockException } from './lock-exception.js';
import type { LockingTaskExecutorListener } from './locking-task-executor-listener.js';
import type { ActiveLockRecord, TrackingLockProviderWrapper } from './tracking-lock-provider.js';

const DEFAULT_MAX_KEEP_ALIVE_FAILURES = 16;

export interface LockHealthEvent {
  readonly name: string;
  readonly at: number;
  readonly lockAtMostFor: number;
  readonly lockAtLeastFor: number;
}

export interface KeepAliveFailureRecord extends LockHealthEvent {
  readonly errorType: string;
}

export interface LockHealthSnapshot {
  readonly takenAt: number;
  readonly activeLocks: readonly ActiveLockRecord[];
  readonly lastAcquired: LockHealthEvent | undefined;
  readonly lastSkipped: LockHealthEvent | undefined;
  readonly recentKeepAliveFailures: readonly KeepAliveFailureRecord[];
  readonly overdueLocks: readonly ActiveLockRecord[];
}

export interface LockHealthMonitorOptions {
  readonly tracking: TrackingLockProviderWrapper;
  readonly maxKeepAliveFailures?: number;
}

export interface LockHealthMonitor extends LockingTaskExecutorListener {
  onKeepAliveFailure(config: LockConfiguration, error: unknown): void;
  snapshot(): LockHealthSnapshot;
  formatSnapshot(snapshot?: LockHealthSnapshot): string;
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return 'Error';
}

function eventFrom(config: LockConfiguration, at: number): LockHealthEvent {
  return Object.freeze({
    name: config.name,
    at,
    lockAtMostFor: config.lockAtMostFor,
    lockAtLeastFor: config.lockAtLeastFor,
  });
}

function compareByName(a: ActiveLockRecord, b: ActiveLockRecord): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function formatEvent(label: string, event: LockHealthEvent | undefined): string {
  if (!event) return `${label}: none`;
  return `${label}: ${event.name} at=${event.at} lockAtMostFor=${event.lockAtMostFor} lockAtLeastFor=${event.lockAtLeastFor}`;
}

function formatActiveLock(lock: ActiveLockRecord, takenAt: number): string {
  return `  - ${lock.name} acquiredAt=${lock.acquiredAt} updatedAt=${lock.updatedAt} heldMs=${takenAt - lock.acquiredAt} lockAtMostFor=${lock.lockAtMostFor} lockAtLeastFor=${lock.lockAtLeastFor}`;
}

function formatKeepAliveFailure(failure: KeepAliveFailureRecord): string {
  return `  - ${failure.name} at=${failure.at} errorType=${failure.errorType} lockAtMostFor=${failure.lockAtMostFor}`;
}

function safeUpdate(update: () => void): void {
  try {
    update();
  } catch {}
}

function freezeSnapshot(snapshot: LockHealthSnapshot): LockHealthSnapshot {
  Object.freeze(snapshot.activeLocks);
  Object.freeze(snapshot.overdueLocks);
  Object.freeze(snapshot.recentKeepAliveFailures);
  return Object.freeze(snapshot);
}

export function createLockHealthMonitor(options: LockHealthMonitorOptions): LockHealthMonitor {
  const maxKeepAliveFailures = options.maxKeepAliveFailures ?? DEFAULT_MAX_KEEP_ALIVE_FAILURES;
  if (maxKeepAliveFailures < 1) {
    throw new LockException('maxKeepAliveFailures must be at least 1');
  }

  const tracking = options.tracking;
  let lastAcquired: LockHealthEvent | undefined;
  let lastSkipped: LockHealthEvent | undefined;
  const keepAliveFailures: KeepAliveFailureRecord[] = [];

  const onLockAcquired = (config: LockConfiguration): void => {
    safeUpdate(() => {
      lastAcquired = eventFrom(config, ClockProvider.now());
    });
  };

  const onLockNotAcquired = (config: LockConfiguration): void => {
    safeUpdate(() => {
      lastSkipped = eventFrom(config, ClockProvider.now());
    });
  };

  const onKeepAliveFailure = (config: LockConfiguration, error: unknown): void => {
    safeUpdate(() => {
      keepAliveFailures.push(
        Object.freeze({
          ...eventFrom(config, ClockProvider.now()),
          errorType: errorType(error),
        }),
      );
      while (keepAliveFailures.length > maxKeepAliveFailures) {
        keepAliveFailures.shift();
      }
    });
  };

  const snapshot = (): LockHealthSnapshot => {
    const takenAt = ClockProvider.now();
    const activeLocks = [...tracking.getActiveLockRecords()].sort(compareByName);
    const overdueLocks = activeLocks.filter((lock) => takenAt - lock.updatedAt > lock.lockAtMostFor);
    return freezeSnapshot({
      takenAt,
      activeLocks,
      lastAcquired,
      lastSkipped,
      recentKeepAliveFailures: [...keepAliveFailures],
      overdueLocks,
    });
  };

  const formatSnapshot = (value?: LockHealthSnapshot): string => {
    const current = value ?? snapshot();
    const lines = [
      `tslock lock health takenAt=${current.takenAt}`,
      `activeLocks: ${current.activeLocks.length}`,
      ...current.activeLocks.map((lock) => formatActiveLock(lock, current.takenAt)),
      `overdueLocks: ${current.overdueLocks.length}`,
      ...current.overdueLocks.map((lock) => formatActiveLock(lock, current.takenAt)),
      formatEvent('lastAcquired', current.lastAcquired),
      formatEvent('lastSkipped', current.lastSkipped),
      `recentKeepAliveFailures: ${current.recentKeepAliveFailures.length}`,
      ...current.recentKeepAliveFailures.map(formatKeepAliveFailure),
    ];
    return lines.join('\n');
  };

  return Object.freeze({
    onLockAttempt: () => {},
    onLockAcquired,
    onLockNotAcquired,
    onTaskStarted: () => {},
    onTaskFinished: () => {},
    onUnlockError: () => {},
    onKeepAliveFailure,
    snapshot,
    formatSnapshot,
  });
}
