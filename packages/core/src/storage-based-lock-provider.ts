import { AbstractSimpleLock, type SimpleLock } from './simple-lock.js';
import { Utils } from './utils.js';
import type { LockConfiguration } from './lock-configuration.js';
import type { ExtensibleLockProvider } from './lock-provider.js';

export interface StorageAccessor {
  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration): Promise<boolean>;
}

export abstract class AbstractStorageAccessor implements StorageAccessor {
  abstract insertRecord(config: LockConfiguration): Promise<boolean>;
  abstract updateRecord(config: LockConfiguration): Promise<boolean>;
  abstract unlock(config: LockConfiguration): Promise<void>;
  abstract extend(config: LockConfiguration): Promise<boolean>;

  protected getHostname(): string {
    return Utils.getHostname();
  }
}

export class LockRecordRegistry {
  private readonly records = new Set<string>();

  lockRecordRecentlyCreated(name: string): boolean {
    return this.records.has(name);
  }

  addRecord(name: string): void {
    this.records.add(name);
  }

  clearCache(name: string): void {
    this.records.delete(name);
  }
}

class StorageLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: StorageAccessor,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.accessor.unlock(this.config);
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    const ok = await this.accessor.extend(newConfig);
    return ok ? new StorageLock(newConfig, this.accessor) : undefined;
  }
}

export class StorageBasedLockProvider implements ExtensibleLockProvider {
  private readonly registry = new LockRecordRegistry();

  constructor(private readonly accessor: StorageAccessor) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    let justInserted = false;
    if (!this.registry.lockRecordRecentlyCreated(config.name)) {
      const inserted = await this.accessor.insertRecord(config);
      this.registry.addRecord(config.name);
      justInserted = true;
      if (inserted) {
        return new StorageLock(config, this.accessor);
      }
    }

    let updated: boolean;
    try {
      updated = await this.accessor.updateRecord(config);
    } catch (e) {
      if (justInserted) {
        this.registry.clearCache(config.name);
      }
      throw e;
    }

    if (updated) {
      return new StorageLock(config, this.accessor);
    }
    return undefined;
  }

  clearCache(name: string): void {
    this.registry.clearCache(name);
  }
}
