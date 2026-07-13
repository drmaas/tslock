import {
  ClockProvider,
  type LockConfiguration,
  type LockProvider,
  type SimpleLock,
  lockAtMostUntil,
} from '@tslock/core';
import type { KV } from 'nats';
import { StorageType, connect } from 'nats';
import { bytesToLong, longToBytes } from './long-utils.js';
import type { NatsLockProviderOptions } from './nats-configuration.js';
import { NatsLock } from './nats-lock.js';

function isNatsConflictError(e: unknown): boolean {
  if (e && typeof e === 'object') {
    const err = e as { code?: number; message?: string };
    if (err.code === 10071) return true;
    if (err.message?.includes('stream name already in use')) return true;
  }
  return false;
}

export class NatsLockProvider implements LockProvider {
  constructor(private readonly kv: KV) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const newLockUntil = lockAtMostUntil(config);
    const value = longToBytes(newLockUntil);

    const entry = await this.kv.get(config.name);
    if (entry === null) {
      try {
        await this.kv.create(config.name, value);
        return new NatsLock(this.kv, config);
      } catch (e) {
        if (isNatsConflictError(e)) return undefined;
        throw e;
      }
    }

    const existingLockUntil = bytesToLong(entry.value);
    if (existingLockUntil > now) return undefined;

    try {
      await this.kv.update(config.name, value, entry.revision);
      return new NatsLock(this.kv, config);
    } catch (e) {
      if (isNatsConflictError(e)) return undefined;
      throw e;
    }
  }
}

export async function createNatsLockProvider(options: NatsLockProviderOptions): Promise<NatsLockProvider> {
  const nc = await connect({ servers: options.servers, ...options.connectionOptions });
  const js = nc.jetstream();
  const bucketName = options.bucketName ?? 'shedlock-locks';
  const storage = options.storage ?? StorageType.Memory;
  const kv = await js.views.kv(bucketName, { storage });
  return new NatsLockProvider(kv);
}
