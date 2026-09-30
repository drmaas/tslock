import type { CloudflareKvNamespace, CloudflareKvPutOptions } from '../src/cloudflare-kv-namespace.js';

export interface MemoryKvEntry {
  value: string;
  expirationTtl?: number;
}

export class MemoryKvNamespace implements CloudflareKvNamespace {
  readonly entries = new Map<string, MemoryKvEntry>();

  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: CloudflareKvPutOptions): Promise<void> {
    this.entries.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export class PopCacheKv implements CloudflareKvNamespace {
  constructor(
    private readonly central: { value: string | null },
    public cache: string | null | undefined = undefined,
  ) {}

  async get(_key: string): Promise<string | null> {
    if (this.cache !== undefined) return this.cache;
    return this.central.value;
  }

  async put(_key: string, value: string, _options?: CloudflareKvPutOptions): Promise<void> {
    this.central.value = value;
    this.cache = value;
  }

  async delete(_key: string): Promise<void> {
    this.central.value = null;
    this.cache = null;
  }
}

export class RateLimitedKv extends MemoryKvNamespace {
  private readonly lastWriteAt = new Map<string, number>();

  private noteWrite(key: string): void {
    const now = Date.now();
    const previous = this.lastWriteAt.get(key);
    if (previous !== undefined && now - previous < 1000) {
      throw new Error('429 KV write rate limit: 1 write per second per key');
    }
    this.lastWriteAt.set(key, now);
  }

  override async put(key: string, value: string, options?: CloudflareKvPutOptions): Promise<void> {
    this.noteWrite(key);
    await super.put(key, value, options);
  }

  override async delete(key: string): Promise<void> {
    this.noteWrite(key);
    await super.delete(key);
  }
}
