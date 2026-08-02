import { ClockProvider } from './clock-provider.js';
import type { LockConfiguration } from './lock-configuration.js';
import { lockAtMostUntil } from './lock-configuration.js';
import { LockException } from './lock-exception.js';
import type { ExtensibleLockProvider } from './lock-provider.js';
import type { Scheduler } from './scheduler.js';
import { DefaultScheduler } from './scheduler.js';
import { AbstractSimpleLock, type SimpleLock } from './simple-lock.js';

export const MIN_LOCK_AT_MOST_FOR = 30_000;

class KeepAliveLock extends AbstractSimpleLock {
  private active = true;
  private remainingLockAtLeastFor: number;
  private readonly intervalHandle: { clear(): void };
  private currentLock: SimpleLock;

  constructor(
    initialLock: SimpleLock,
    private readonly baseConfig: LockConfiguration,
    scheduler: Scheduler,
    private readonly onKeepAliveFailure?: (config: LockConfiguration, error: unknown) => void,
  ) {
    super(baseConfig);
    this.currentLock = initialLock;
    this.remainingLockAtLeastFor = baseConfig.lockAtLeastFor;
    this.intervalHandle = scheduler.setInterval(
      () => this.safeExtendForNextPeriod(),
      Math.floor(baseConfig.lockAtMostFor / 2),
    );
  }

  private deactivate(): void {
    this.active = false;
    this.intervalHandle.clear();
  }

  private async extendForNextPeriod(): Promise<void> {
    if (!this.active) return;
    if (lockAtMostUntil(this.baseConfig) < ClockProvider.now()) {
      this.deactivate();
      return;
    }
    const next = Math.max(0, this.remainingLockAtLeastFor);
    const newLock = await this.currentLock.extend(this.baseConfig.lockAtMostFor, next);
    if (!newLock) {
      this.deactivate();
      this.onKeepAliveFailure?.(this.baseConfig, new LockException('Keep-alive lock was lost'));
      return;
    }
    this.currentLock = newLock;
    this.remainingLockAtLeastFor = Math.max(0, next - this.baseConfig.lockAtMostFor / 2);
  }

  private safeExtendForNextPeriod(): Promise<void> {
    return this.extendForNextPeriod().catch((firstError: unknown) =>
      this.extendForNextPeriod().catch(() => {
        this.deactivate();
        this.onKeepAliveFailure?.(this.baseConfig, firstError);
      }),
    );
  }

  protected override async doUnlock(): Promise<void> {
    this.deactivate();
    await this.currentLock.unlock();
  }

  protected override async doExtend(): Promise<SimpleLock | undefined> {
    throw new LockException('KeepAliveLock does not support manual extension');
  }
}

export class KeepAliveLockProvider implements ExtensibleLockProvider {
  static readonly MIN_LOCK_AT_MOST_FOR = MIN_LOCK_AT_MOST_FOR;

  constructor(
    private readonly provider: ExtensibleLockProvider,
    private readonly scheduler: Scheduler = new DefaultScheduler(),
    private readonly onKeepAliveFailure?: (config: LockConfiguration, error: unknown) => void,
  ) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    if (config.lockAtMostFor < KeepAliveLockProvider.MIN_LOCK_AT_MOST_FOR) {
      throw new LockException(
        `lockAtMostFor must be at least ${KeepAliveLockProvider.MIN_LOCK_AT_MOST_FOR}ms when using KeepAliveLockProvider`,
      );
    }
    const lock = await this.provider.lock(config);
    if (!lock) return undefined;
    return new KeepAliveLock(lock, config, this.scheduler, this.onKeepAliveFailure);
  }
}
