import { ClockProvider } from './clock-provider.js';
import type { LockConfiguration } from './lock-configuration.js';
import { LockException } from './lock-exception.js';

export interface SimpleLock {
  unlock(): Promise<void>;
  extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined>;
}

export abstract class AbstractSimpleLock implements SimpleLock {
  protected valid: boolean = true;

  constructor(protected readonly config: LockConfiguration) {}

  async unlock(): Promise<void> {
    this.checkValidity();
    await this.doUnlock();
    this.valid = false;
  }

  async extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined> {
    this.checkValidity();
    const newConfig: LockConfiguration = {
      name: this.config.name,
      lockAtMostFor,
      lockAtLeastFor,
      createdAt: ClockProvider.now(),
    };
    const result = await this.doExtend(newConfig);
    this.valid = false;
    return result;
  }

  protected abstract doUnlock(): Promise<void>;

  protected async doExtend(_config: LockConfiguration): Promise<SimpleLock | undefined> {
    throw new LockException('Extend not supported by this provider');
  }

  protected checkValidity(): void {
    if (!this.valid) {
      throw new LockException('Lock has already been released or extended');
    }
  }
}
