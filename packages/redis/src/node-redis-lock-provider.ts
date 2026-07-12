import { InternalRedisLockProvider, type RedisLockProviderConfig } from '@tslock/redis-core';
import type { RedisClientType } from 'redis';
import { NodeRedisTemplate } from './node-redis-template.js';

export class NodeRedisLockProvider extends InternalRedisLockProvider {
  constructor(client: RedisClientType, config: RedisLockProviderConfig = {}) {
    super(new NodeRedisTemplate(client), config);
  }
}

export function createNodeRedisLockProvider(
  client: RedisClientType,
  config: RedisLockProviderConfig = {},
): NodeRedisLockProvider {
  return new NodeRedisLockProvider(client, config);
}
