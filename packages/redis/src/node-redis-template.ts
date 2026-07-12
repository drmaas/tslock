import type { RedisClientType } from 'redis';
import type { RedisTemplate } from '@tslock/redis-core';

export class NodeRedisTemplate implements RedisTemplate {
  constructor(private readonly client: RedisClientType) {}

  async setIfAbsent(key: string, value: string, expireMs: number): Promise<boolean> {
    const result = await this.client.set(key, value, { NX: true, PX: expireMs });
    return result === 'OK';
  }

  async setIfPresent(key: string, value: string, expireMs: number): Promise<boolean> {
    const result = await this.client.set(key, value, { XX: true, PX: expireMs });
    return result === 'OK';
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.client.del(key);
    return result > 0;
  }

  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.eval(script, { keys, arguments: args.map(String) });
  }

  async deleteKey(key: string): Promise<void> {
    await this.client.del(key);
  }
}
