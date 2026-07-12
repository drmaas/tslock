export interface HazelcastLockProviderOptions {
  lockStoreKey?: string;
  lockLeaseTimeMs?: number;
}

export const DEFAULT_LOCK_STORE_KEY = 'shedlock_storage';
export const DEFAULT_LOCK_LEASE_TIME = 30_000;

export interface ResolvedHazelcastOptions {
  lockStoreKey: string;
  lockLeaseTimeMs: number;
}

export function resolveOptions(options?: HazelcastLockProviderOptions): ResolvedHazelcastOptions {
  return {
    lockStoreKey: options?.lockStoreKey ?? DEFAULT_LOCK_STORE_KEY,
    lockLeaseTimeMs: options?.lockLeaseTimeMs ?? DEFAULT_LOCK_LEASE_TIME,
  };
}
