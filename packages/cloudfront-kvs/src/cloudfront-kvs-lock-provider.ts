import {
  type CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import {
  ClockProvider,
  type ExtensibleLockProvider,
  type LockConfiguration,
  LockException,
  lockAtMostUntil,
  type SimpleLock,
  Utils,
  unlockTime,
} from '@tslock/core';
import {
  type CloudFrontKvsConfiguration,
  type CloudFrontKvsLockProviderOptions,
  resolveCloudFrontKvsConfiguration,
} from './cloudfront-kvs-configuration.js';
import { isConflict, isNotFound } from './cloudfront-kvs-errors.js';
import { CloudFrontKvsLock } from './cloudfront-kvs-lock.js';
import {
  buildLockRecord,
  type CloudFrontKvsLockRecord,
  decodeLockRecord,
  encodeLockRecord,
  parseLockUntilMs,
} from './lock-record.js';

export class CloudFrontKvsLockProvider implements ExtensibleLockProvider {
  private readonly config: CloudFrontKvsConfiguration;
  private readonly client: CloudFrontKeyValueStoreClient;

  constructor(options: CloudFrontKvsLockProviderOptions) {
    this.config = resolveCloudFrontKvsConfiguration(options);
    this.client = this.config.client;
  }

  private storageKey(name: string): string {
    const key = this.config.keyPrefix + name;
    if (Buffer.byteLength(key, 'utf8') > 512) {
      throw new LockException(`Lock storage key exceeds CloudFront KVS 512-byte limit: ${key.length} chars`);
    }
    if (key.length < 1) {
      throw new LockException('Lock storage key must be non-empty');
    }
    return key;
  }

  private async describeEtag(): Promise<string> {
    const out = await this.client.send(new DescribeKeyValueStoreCommand({ KvsARN: this.config.kvsArn }));
    if (!out.ETag) {
      throw new LockException('DescribeKeyValueStore returned no ETag');
    }
    return out.ETag;
  }

  private async getRecord(name: string): Promise<CloudFrontKvsLockRecord | null> {
    try {
      const out = await this.client.send(
        new GetKeyCommand({
          KvsARN: this.config.kvsArn,
          Key: this.storageKey(name),
        }),
      );
      if (out.Value === undefined || out.Value === null) return null;
      return decodeLockRecord(out.Value);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  private async putRecord(name: string, record: CloudFrontKvsLockRecord, etag: string): Promise<void> {
    await this.client.send(
      new PutKeyCommand({
        KvsARN: this.config.kvsArn,
        Key: this.storageKey(name),
        Value: encodeLockRecord(record),
        IfMatch: etag,
      }),
    );
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const hostname = Utils.getHostname();
    for (let attempt = 0; attempt < this.config.maxEtagRetries; attempt++) {
      const etag = await this.describeEtag();
      const existing = await this.getRecord(config.name);
      const now = ClockProvider.now();
      if (existing !== null && parseLockUntilMs(existing) > now) {
        return undefined;
      }
      const record = buildLockRecord(lockAtMostUntil(config), config.createdAt, hostname);
      try {
        await this.putRecord(config.name, record, etag);
        return new CloudFrontKvsLock(config, this);
      } catch (e) {
        if (isConflict(e)) continue;
        throw e;
      }
    }
    return undefined;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const hostname = Utils.getHostname();
    for (let attempt = 0; attempt < this.config.maxEtagRetries; attempt++) {
      const etag = await this.describeEtag();
      const existing = await this.getRecord(config.name);
      if (existing === null) return;
      if (existing.lockedBy !== hostname) return;
      const record = buildLockRecord(
        unlockTime(config),
        Date.parse(existing.lockedAt) || config.createdAt,
        existing.lockedBy,
      );
      try {
        await this.putRecord(config.name, record, etag);
        return;
      } catch (e) {
        if (isConflict(e)) continue;
        throw e;
      }
    }
  }

  async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const hostname = Utils.getHostname();
    for (let attempt = 0; attempt < this.config.maxEtagRetries; attempt++) {
      const etag = await this.describeEtag();
      const existing = await this.getRecord(config.name);
      if (existing === null) return undefined;
      if (existing.lockedBy !== hostname) return undefined;
      if (parseLockUntilMs(existing) <= ClockProvider.now()) return undefined;
      const record = buildLockRecord(
        lockAtMostUntil(config),
        Date.parse(existing.lockedAt) || config.createdAt,
        hostname,
      );
      try {
        await this.putRecord(config.name, record, etag);
        return new CloudFrontKvsLock(config, this);
      } catch (e) {
        if (isConflict(e)) continue;
        throw e;
      }
    }
    return undefined;
  }
}

export function createCloudFrontKvsLockProvider(options: CloudFrontKvsLockProviderOptions): CloudFrontKvsLockProvider {
  return new CloudFrontKvsLockProvider(options);
}
