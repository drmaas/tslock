import type { Storage } from '@google-cloud/storage';
import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  LockException,
  lockAtMostUntil,
  Utils,
  unlockTime,
} from '@tslock/core';
import { isNotFound, isPreconditionFailed } from './gcs-errors.js';
import type { GcsProviderConfig } from './gcs-provider-config.js';

type GetResult = {
  generation: number;
  metadata: Record<string, string>;
} | null;

export class GcsStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly storage: Storage,
    private readonly config: GcsProviderConfig,
  ) {
    super();
  }

  protected override getHostname(): string {
    return this.config.lockedBy;
  }

  private objectKey(name: string): string {
    return this.config.objectPrefix + name;
  }

  private file(name: string): ReturnType<ReturnType<Storage['bucket']>['file']> {
    return this.storage.bucket(this.config.bucket).file(this.objectKey(name));
  }

  private async getWithMetadata(name: string): Promise<GetResult> {
    try {
      const file = this.file(name);
      const [metadata] = await file.getMetadata();
      return {
        generation: Number(metadata.generation ?? 0),
        metadata: (metadata.metadata ?? {}) as Record<string, string>,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private parseLockUntil(metadata: Record<string, string> | undefined): number {
    const raw = metadata?.lockUntil;
    if (!raw) throw new LockException('Corrupted lock record: missing lockUntil');
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new LockException(`Corrupted lock record: unparseable lockUntil '${raw}'`);
    return ms;
  }

  private buildMetadata(config: LockConfiguration): Record<string, string> {
    return {
      lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
      lockedAt: Utils.toIsoString(config.createdAt),
      lockedBy: this.getHostname(),
      lockName: config.name,
    };
  }

  override async insertRecord(config: LockConfiguration): Promise<boolean> {
    const file = this.file(config.name);
    const [exists] = await file.exists();
    if (exists) return false;
    try {
      await file.save('', {
        metadata: this.buildMetadata(config) as any,
        gzip: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      } as any);
      return true;
    } catch (e) {
      if (isPreconditionFailed(e)) return false;
      throw e;
    }
  }

  override async updateRecord(config: LockConfiguration): Promise<boolean> {
    const current = await this.getWithMetadata(config.name);
    if (current === null) throw new LockException('Lock record not found: ' + config.name);
    const lockUntil = this.parseLockUntil(current.metadata);
    if (lockUntil > ClockProvider.now()) return false;
    const file = this.file(config.name);
    try {
      await file.save('', {
        metadata: this.buildMetadata(config) as any,
        gzip: false,
        preconditionOpts: { ifGenerationMatch: current.generation },
      } as any);
      return true;
    } catch (e) {
      if (isPreconditionFailed(e)) return false;
      throw e;
    }
  }

  override async unlock(config: LockConfiguration): Promise<void> {
    const current = await this.getWithMetadata(config.name);
    if (current === null) return;
    const file = this.file(config.name);
    try {
      await file.setMetadata(
        {
          lockUntil: Utils.toIsoString(unlockTime(config)),
          lockedAt: current.metadata.lockedAt ?? Utils.toIsoString(config.createdAt),
          lockedBy: current.metadata.lockedBy ?? this.getHostname(),
          lockName: current.metadata.lockName ?? config.name,
        } as any,
        { preconditionOpts: { ifGenerationMatch: current.generation } } as any,
      );
    } catch (e) {
      if (isPreconditionFailed(e)) return;
      throw e;
    }
  }

  override async extend(config: LockConfiguration): Promise<boolean> {
    const current = await this.getWithMetadata(config.name);
    if (current === null) return false;
    const lockUntil = this.parseLockUntil(current.metadata);
    const lockedBy = current.metadata.lockedBy;
    if (lockedBy !== this.getHostname()) return false;
    if (lockUntil <= ClockProvider.now()) return false;
    const file = this.file(config.name);
    try {
      await file.setMetadata(
        {
          lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
          lockedAt: current.metadata.lockedAt,
          lockedBy: current.metadata.lockedBy,
          lockName: current.metadata.lockName,
        } as any,
        { preconditionOpts: { ifGenerationMatch: current.generation } } as any,
      );
      return true;
    } catch (e) {
      if (isPreconditionFailed(e)) return false;
      throw e;
    }
  }
}
