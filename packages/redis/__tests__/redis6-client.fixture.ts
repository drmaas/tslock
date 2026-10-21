import type { RedisClientType } from 'redis';
import { createNodeRedisLockProvider, type NodeRedisLockProvider } from '../src/index.js';

export function acceptRedis6Client(client: RedisClientType): NodeRedisLockProvider {
  return createNodeRedisLockProvider(client);
}
