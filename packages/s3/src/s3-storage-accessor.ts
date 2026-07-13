import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  LockException,
  Utils,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';
import { isNotFound, isPreconditionFailed } from './s3-errors.js';
import type { S3ProviderConfig } from './s3-provider-config.js';

function getMetadataValue(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

type HeadResult = { etag: string; metadata: Record<string, string> } | null;

export class S3StorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly s3: S3Client,
    private readonly config: S3ProviderConfig,
  ) {
    super();
  }

  private objectKey(name: string): string {
    return this.config.objectPrefix + name;
  }

  private async headObject(name: string): Promise<HeadResult> {
    try {
      const out = await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(name),
        }),
      );
      return {
        etag: out.ETag as string,
        metadata: (out.Metadata ?? {}) as Record<string, string>,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private parseLockUntil(metadata: Record<string, string> | undefined): number {
    const raw = getMetadataValue(metadata, 'lockUntil');
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
    };
  }

  override async insertRecord(config: LockConfiguration): Promise<boolean> {
    const head = await this.headObject(config.name);
    if (head !== null) return false;
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(config.name),
          Body: '',
          Metadata: this.buildMetadata(config),
          IfNoneMatch: '*',
        }),
      );
      return true;
    } catch (e) {
      if (isPreconditionFailed(e)) return false;
      throw e;
    }
  }

  override async updateRecord(config: LockConfiguration): Promise<boolean> {
    const head = await this.headObject(config.name);
    if (head === null) throw new LockException(`Lock record not found: ${config.name}`);
    const lockUntil = this.parseLockUntil(head.metadata);
    if (lockUntil > ClockProvider.now()) return false;
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(config.name),
          Body: '',
          Metadata: this.buildMetadata(config),
          IfMatch: head.etag,
        }),
      );
      return true;
    } catch (e) {
      if (isPreconditionFailed(e)) return false;
      throw e;
    }
  }

  override async unlock(config: LockConfiguration): Promise<void> {
    const head = await this.headObject(config.name);
    if (head === null) return;
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(config.name),
          Body: '',
          Metadata: {
            lockUntil: Utils.toIsoString(unlockTime(config)),
            lockedAt: getMetadataValue(head.metadata, 'lockedAt') ?? Utils.toIsoString(config.createdAt),
            lockedBy: getMetadataValue(head.metadata, 'lockedBy') ?? this.getHostname(),
          },
          IfMatch: head.etag,
        }),
      );
    } catch (e) {
      if (isPreconditionFailed(e)) return;
      throw e;
    }
  }

  override async extend(config: LockConfiguration): Promise<boolean> {
    const head = await this.headObject(config.name);
    if (head === null) return false;
    const lockUntil = this.parseLockUntil(head.metadata);
    const lockedBy = getMetadataValue(head.metadata, 'lockedBy');
    if (lockedBy !== this.getHostname()) return false;
    if (lockUntil <= ClockProvider.now()) return false;
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(config.name),
          Body: '',
          Metadata: {
            lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
            lockedAt: getMetadataValue(head.metadata, 'lockedAt') ?? Utils.toIsoString(config.createdAt),
            lockedBy: getMetadataValue(head.metadata, 'lockedBy') ?? this.getHostname(),
          },
          IfMatch: head.etag,
        }),
      );
      return true;
    } catch (e) {
      if (isPreconditionFailed(e)) return false;
      throw e;
    }
  }
}
