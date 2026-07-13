import { ClockProvider, createLockConfig } from '@tslock/core';
import { CasMismatchError, DocumentExistsError, DocumentNotFoundError } from 'couchbase';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedOptions } from '../src/couchbase-lock-provider.js';
import { CouchbaseStorageAccessor } from '../src/couchbase-storage-accessor.js';

function opts(overrides?: Partial<ResolvedOptions>): ResolvedOptions {
  return {
    documentIdPrefix: 'shedlock:',
    nameCol: 'name',
    lockUntilCol: 'lockUntil',
    lockedAtCol: 'lockedAt',
    lockedByCol: 'lockedBy',
    lockedByValue: 'my-host',
    ...overrides,
  };
}

function makeCollection(overrides: Record<string, any> = {}) {
  return {
    insert: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ content: {}, cas: '0' }),
    replace: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('CouchbaseStorageAccessor', () => {
  describe('insertRecord', () => {
    it('returns true on success', async () => {
      const col = makeCollection();
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.insertRecord(config())).toBe(true);
      expect(col.insert).toHaveBeenCalledOnce();
    });

    it('returns false on DocumentExistsError', async () => {
      const col = makeCollection({ insert: vi.fn().mockRejectedValue(new DocumentExistsError('exists')) });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.insertRecord(config())).toBe(false);
    });

    it('propagates other errors', async () => {
      const col = makeCollection({ insert: vi.fn().mockRejectedValue(new Error('network')) });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      await expect(accessor.insertRecord(config())).rejects.toThrow('network');
    });
  });

  describe('updateRecord', () => {
    it('returns true when lock expired and replace succeeds', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockUntil: 999_999 }, cas: '1' }),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.updateRecord(config())).toBe(true);
    });

    it('returns false when lock still held', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockUntil: 1_500_000 }, cas: '1' }),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.updateRecord(config())).toBe(false);
    });

    it('propagates DocumentNotFoundError', async () => {
      const col = makeCollection({ get: vi.fn().mockRejectedValue(new DocumentNotFoundError('not found')) });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      await expect(accessor.updateRecord(config())).rejects.toThrow(DocumentNotFoundError);
    });

    it('returns false on CasMismatchError', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockUntil: 999_999 }, cas: '1' }),
        replace: vi.fn().mockRejectedValue(new CasMismatchError('cas mismatch')),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.updateRecord(config())).toBe(false);
    });
  });

  describe('unlock', () => {
    it('resolves without error on success', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockUntil: 1_050_000 }, cas: '1' }),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      await expect(accessor.unlock(config())).resolves.toBeUndefined();
    });

    it('no-ops on DocumentNotFoundError', async () => {
      const col = makeCollection({ get: vi.fn().mockRejectedValue(new DocumentNotFoundError('not found')) });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      await expect(accessor.unlock(config())).resolves.toBeUndefined();
    });

    it('no-ops on CasMismatchError', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockUntil: 1_050_000 }, cas: '1' }),
        replace: vi.fn().mockRejectedValue(new CasMismatchError('cas mismatch')),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      await expect(accessor.unlock(config())).resolves.toBeUndefined();
    });
  });

  describe('extend', () => {
    it('returns true when owned and valid', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockedBy: 'my-host', lockUntil: 1_050_000 }, cas: '1' }),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.extend(config())).toBe(true);
    });

    it('returns false when not owned', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockedBy: 'other-host', lockUntil: 1_050_000 }, cas: '1' }),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.extend(config())).toBe(false);
    });

    it('returns false when expired', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockedBy: 'my-host', lockUntil: 900_000 }, cas: '1' }),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.extend(config())).toBe(false);
    });

    it('returns false on DocumentNotFoundError', async () => {
      const col = makeCollection({ get: vi.fn().mockRejectedValue(new DocumentNotFoundError('not found')) });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.extend(config())).toBe(false);
    });

    it('returns false on CasMismatchError', async () => {
      const col = makeCollection({
        get: vi.fn().mockResolvedValue({ content: { lockedBy: 'my-host', lockUntil: 1_050_000 }, cas: '1' }),
        replace: vi.fn().mockRejectedValue(new CasMismatchError('cas mismatch')),
      });
      const accessor = new CouchbaseStorageAccessor(col, opts());
      expect(await accessor.extend(config())).toBe(false);
    });
  });
});
