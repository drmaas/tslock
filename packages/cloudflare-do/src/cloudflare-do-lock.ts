import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { CloudflareDoLockProvider } from './cloudflare-do-lock-provider.js';

export class CloudflareDoLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly provider: CloudflareDoLockProvider,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.provider.unlock(this.config);
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    return await this.provider.extend(newConfig);
  }
}
