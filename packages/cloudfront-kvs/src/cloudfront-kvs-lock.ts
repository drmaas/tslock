import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { CloudFrontKvsLockProvider } from './cloudfront-kvs-lock-provider.js';

export class CloudFrontKvsLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly provider: CloudFrontKvsLockProvider,
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
