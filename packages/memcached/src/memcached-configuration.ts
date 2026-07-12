export interface MemcachedLockProviderOptions {
  servers?: string;
  env?: string;
  clientOptions?: Record<string, unknown>;
}
