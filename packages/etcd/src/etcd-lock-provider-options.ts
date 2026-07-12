export const DEFAULT_ENV = 'default';
export const MILLIS_IN_SECOND = 1000;

export interface EtcdLockProviderOptions {
  env?: string;
}

export function resolveOptions(options?: EtcdLockProviderOptions): { env: string } {
  return { env: options?.env ?? DEFAULT_ENV };
}
