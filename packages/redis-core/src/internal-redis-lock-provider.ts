import {
  AbstractSimpleLock,
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
  lockAtMostUntil,
} from '@tslock/core';
import type { RedisTemplate } from './redis-template.js';
import { DEL_IF_EQUALS_SCRIPT, EXTEND_IF_EQUALS_SCRIPT } from './scripts.js';

export const DEFAULT_KEY_PREFIX = 'job-lock';
export const ENV_DEFAULT = 'default';

export interface RedisLockProviderConfig {
  keyPrefix?: string;
  env?: string;
  safeUpdate?: boolean;
}

export interface RedisLockValueParts {
  hostname: string;
  isoNow: string;
  randomId: string;
}

class RedisLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly redis: RedisTemplate,
    private readonly key: string,
    private readonly value: string,
    private readonly safeUpdate: boolean,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    if (this.safeUpdate) {
      await this.redis.eval(DEL_IF_EQUALS_SCRIPT, [this.key], [this.value]);
    } else {
      await this.redis.deleteKey(this.key);
    }
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    const extendUntil = lockAtMostUntil(newConfig);
    const expireMs = Math.max(0, extendUntil - Date.now());
    let ok: boolean;
    if (this.safeUpdate) {
      const result = await this.redis.eval(EXTEND_IF_EQUALS_SCRIPT, [this.key], [this.value, expireMs]);
      ok = Number(result) === 1;
    } else {
      ok = await this.redis.setIfPresent(this.key, this.value, expireMs);
    }
    if (!ok) return undefined;
    return new RedisLock(newConfig, this.redis, this.key, this.value, this.safeUpdate);
  }
}

export class InternalRedisLockProvider implements ExtensibleLockProvider {
  static readonly DEFAULT_KEY_PREFIX = DEFAULT_KEY_PREFIX;
  static readonly ENV_DEFAULT = ENV_DEFAULT;

  private readonly keyPrefix: string;
  private readonly safeUpdate: boolean;

  constructor(
    private readonly redis: RedisTemplate,
    config: RedisLockProviderConfig = {},
  ) {
    this.keyPrefix = `${config.keyPrefix ?? DEFAULT_KEY_PREFIX}:${config.env ?? ENV_DEFAULT}`;
    this.safeUpdate = config.safeUpdate ?? true;
  }

  buildKey(lockName: string): string {
    return `${this.keyPrefix}:${lockName}`;
  }

  buildValue(parts: RedisLockValueParts): string {
    return RedisLock.buildValue(parts);
  }

  static parseKey(key: string, prefix: string, env: string): string {
    return key.substring(`${prefix}:${env}:`.length);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const key = this.buildKey(config.name);
    const value = RedisLock.buildValue({
      hostname: 'tslock',
      isoNow: new Date(lockAtMostUntil(config)).toISOString(),
      randomId: Math.random().toString(36).slice(2),
    });
    const expireMs = Math.max(0, lockAtMostUntil(config) - Date.now());
    const acquired = await this.redis.setIfAbsent(key, value, expireMs);
    if (!acquired) return undefined;
    return new RedisLock(config, this.redis, key, value, this.safeUpdate);
  }
}
