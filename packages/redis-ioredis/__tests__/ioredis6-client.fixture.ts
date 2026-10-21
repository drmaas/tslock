import type { Redis } from 'ioredis';
import { createIoRedisLockProvider, type IoRedisLockProvider } from '../src/index.js';

export function acceptIoRedis6Client(client: Redis): IoRedisLockProvider {
  return createIoRedisLockProvider(client);
}
