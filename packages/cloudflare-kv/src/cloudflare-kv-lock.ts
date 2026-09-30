import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { CloudflareKvLockProvider } from './cloudflare-kv-lock-provider.js';

export class CloudflareKvLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly token: string,
    private readonly provider: CloudflareKvLockProvider,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.provider.unlock(this.config, this.token);
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    return await this.provider.extend(newConfig, this.token);
  }
}
