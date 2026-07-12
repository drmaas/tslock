import { InternalRedisLockProvider, type RedisLockProviderConfig } from '@tslock/redis-core';
import type { Redis } from 'ioredis';
import { IoRedisTemplate } from './io-redis-template.js';

export class IoRedisLockProvider extends InternalRedisLockProvider {
  constructor(client: Redis, config: RedisLockProviderConfig = {}) {
    super(new IoRedisTemplate(client), config);
  }
}

export function createIoRedisLockProvider(
  client: Redis,
  config: RedisLockProviderConfig = {},
): IoRedisLockProvider {
  return new IoRedisLockProvider(client, config);
}
