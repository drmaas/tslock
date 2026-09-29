import { handleTslockLockRequest } from './handle-lock-request.js';
import type { DoLockRecord } from './protocol.js';

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

export function createDoStorageAdapter(storage: DurableObjectStorageLike) {
  return {
    async get(key: string): Promise<DoLockRecord | undefined> {
      return await storage.get<DoLockRecord>(key);
    },
    async put(key: string, value: DoLockRecord): Promise<void> {
      await storage.put(key, value);
    },
  };
}

export class TslockLockDurableObject {
  constructor(private readonly ctx: DurableObjectStateLike) {}

  async fetch(request: Request): Promise<Response> {
    return handleTslockLockRequest(createDoStorageAdapter(this.ctx.storage), request);
  }
}
