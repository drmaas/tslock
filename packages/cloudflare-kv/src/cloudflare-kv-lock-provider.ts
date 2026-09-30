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
  type CloudflareKvConfiguration,
  type CloudflareKvLockProviderOptions,
  resolveCloudflareKvConfiguration,
} from './cloudflare-kv-configuration.js';
import { CloudflareKvLock } from './cloudflare-kv-lock.js';
import { kvExpirationTtlSeconds } from './kv-expiration.js';
import { decodeLockRecord, encodeLockRecord, type KvLockRecord } from './lock-record.js';

const MAX_KEY_BYTES = 512;

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

function newToken(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new LockException('crypto.randomUUID is required to create a Workers KV lock token');
  }
  return globalThis.crypto.randomUUID();
}

/**
 * Best-effort Workers KV lock provider.
 *
 * Workers KV is eventually consistent, caches misses, and has no compare-and-swap.
 * Two callers can both acquire. Deletes can lag (phantom holds). `expirationTtl`
 * cannot be below 60 seconds; logical expiry is `lockUntil`. Each key allows about
 * one write per second (HTTP 429).
 *
 * For mutual exclusion use `@tslock/cloudflare-do`.
 */
export class CloudflareKvLockProvider implements ExtensibleLockProvider {
  private readonly config: CloudflareKvConfiguration;

  constructor(options: CloudflareKvLockProviderOptions) {
    this.config = resolveCloudflareKvConfiguration(options);
  }

  private storageKey(name: string): string {
    const key = this.config.keyPrefix + name;
    const size = utf8Size(key);
    if (size < 1 || size > MAX_KEY_BYTES) {
      throw new LockException(`Lock storage key must be 1..${MAX_KEY_BYTES} UTF-8 bytes`);
    }
    return key;
  }

  private async read(key: string): Promise<KvLockRecord | null> {
    const raw = await this.config.kv.get(key);
    if (raw === null) return null;
    return decodeLockRecord(raw);
  }

  private async write(key: string, record: KvLockRecord, now: number): Promise<void> {
    await this.config.kv.put(key, encodeLockRecord(record), {
      expirationTtl: kvExpirationTtlSeconds(record.lockUntil, now),
    });
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const key = this.storageKey(config.name);
    const now = ClockProvider.now();
    const existing = await this.read(key);
    if (existing !== null && existing.lockUntil > now) {
      return undefined;
    }
    const token = newToken();
    const record: KvLockRecord = {
      lockUntil: lockAtMostUntil(config),
      lockedAt: config.createdAt,
      lockedBy: Utils.getHostname(),
      token,
    };
    await this.write(key, record, now);
    if (this.config.confirmWrite) {
      const confirmed = await this.read(key);
      if (confirmed === null || confirmed.token !== token) {
        return undefined;
      }
    }
    return new CloudflareKvLock(config, token, this);
  }

  async unlock(config: LockConfiguration, token: string): Promise<void> {
    const key = this.storageKey(config.name);
    const existing = await this.read(key);
    if (existing === null || existing.token !== token) return;
    const until = unlockTime(config);
    const now = ClockProvider.now();
    if (until <= now) {
      await this.config.kv.delete(key);
      return;
    }
    await this.write(
      key,
      {
        lockUntil: until,
        lockedAt: existing.lockedAt,
        lockedBy: existing.lockedBy,
        token,
      },
      now,
    );
  }

  async extend(config: LockConfiguration, token: string): Promise<SimpleLock | undefined> {
    const key = this.storageKey(config.name);
    const now = ClockProvider.now();
    const existing = await this.read(key);
    if (existing === null || existing.token !== token || existing.lockUntil <= now) {
      return undefined;
    }
    const record: KvLockRecord = {
      lockUntil: lockAtMostUntil(config),
      lockedAt: existing.lockedAt,
      lockedBy: existing.lockedBy,
      token,
    };
    await this.write(key, record, now);
    if (this.config.confirmWrite) {
      const confirmed = await this.read(key);
      if (confirmed === null || confirmed.token !== token) {
        return undefined;
      }
    }
    return new CloudflareKvLock(config, token, this);
  }
}

/**
 * Best-effort Workers KV lock provider.
 *
 * Pass `acknowledgeAdvisoryLock: true`. Stale reads can yield two holders, deletes
 * can lag, TTL cannot be under 60 seconds, and each key allows about one write per
 * second. Use `@tslock/cloudflare-do` when overlapping execution is unacceptable.
 */
export function createCloudflareKvLockProvider(options: CloudflareKvLockProviderOptions): CloudflareKvLockProvider {
  return new CloudflareKvLockProvider(options);
}
