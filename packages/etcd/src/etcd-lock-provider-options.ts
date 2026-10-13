const DEFAULT_ENV = 'default';

export interface EtcdLockProviderOptions {
  env?: string;
}

export function resolveOptions(options?: EtcdLockProviderOptions): { env: string } {
  return { env: options?.env ?? DEFAULT_ENV };
}
