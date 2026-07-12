export interface RedisTemplate {
  setIfAbsent(key: string, value: string, expireMs: number): Promise<boolean>;
  setIfPresent(key: string, value: string, expireMs: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  deleteKey(key: string): Promise<void>;
}
