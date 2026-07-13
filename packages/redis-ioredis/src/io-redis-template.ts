import type { RedisTemplate } from '@tslock/redis-core';
import type { Redis } from 'ioredis';

export class IoRedisTemplate implements RedisTemplate {
  constructor(private readonly client: Redis) {}

  async setIfAbsent(key: string, value: string, expireMs: number): Promise<boolean> {
    const result = await this.client.call('SET', key, value, 'NX', 'PX', String(expireMs));
    return result === 'OK';
  }

  async setIfPresent(key: string, value: string, expireMs: number): Promise<boolean> {
    const result = await this.client.call('SET', key, value, 'XX', 'PX', String(expireMs));
    return result === 'OK';
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.client.del(key);
    return result > 0;
  }

  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  async deleteKey(key: string): Promise<void> {
    await this.client.del(key);
  }
}
