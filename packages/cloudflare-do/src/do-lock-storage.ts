import type { DoLockRecord } from './protocol.js';

export interface DoLockStorage {
  get(key: string): Promise<DoLockRecord | undefined>;
  put(key: string, value: DoLockRecord): Promise<void>;
}

export function storageKeyForLock(name: string): string {
  return `lock:${name}`;
}

export function createMemoryDoLockStorage(): DoLockStorage {
  const map = new Map<string, DoLockRecord>();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}
