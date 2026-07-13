import type { Storage } from '@google-cloud/storage';
import { ClockProvider } from '@tslock/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GcsProviderConfig } from '../src/gcs-provider-config.js';
import { createGcsProviderConfig } from '../src/gcs-provider-config.js';
import { GcsStorageAccessor } from '../src/gcs-storage-accessor.js';

function gcsError(code: number): Error {
  return Object.assign(new Error('GCS error'), { code });
}

const defaultConfig = {
  name: 'test-lock',
  lockAtMostFor: 10000,
  lockAtLeastFor: 1000,
  createdAt: 0,
};

function createMockFile() {
  return {
    exists: vi.fn(),
    get: vi.fn(),
    getMetadata: vi.fn(),
    save: vi.fn(),
    setMetadata: vi.fn(),
  };
}

describe('GcsStorageAccessor', () => {
  let mockFile: ReturnType<typeof createMockFile>;
  let mockBucket: { file: ReturnType<typeof vi.fn> };
  let mockStorage: Storage;
  let providerConfig: GcsProviderConfig;
  let accessor: GcsStorageAccessor;

  beforeEach(() => {
    mockFile = createMockFile();
    mockBucket = { file: vi.fn().mockReturnValue(mockFile) };
    mockStorage = { bucket: vi.fn().mockReturnValue(mockBucket) } as unknown as Storage;
    providerConfig = createGcsProviderConfig({
      bucket: 'test-bucket',
      lockedBy: 'test-host',
    });
    accessor = new GcsStorageAccessor(mockStorage, providerConfig);
  });

  describe('insertRecord', () => {
    it('happy path: exists=false → save succeeds → true', async () => {
      mockFile.exists.mockResolvedValue([false]);
      mockFile.save.mockResolvedValue(undefined);

      const result = await accessor.insertRecord(defaultConfig);

      expect(result).toBe(true);
      expect(mockFile.exists).toHaveBeenCalledTimes(1);
      expect(mockFile.save).toHaveBeenCalledTimes(1);
      const saveOptions = mockFile.save.mock.calls[0][1];
      expect(saveOptions.preconditionOpts.ifGenerationMatch).toBe(0);
      expect(saveOptions.gzip).toBe(false);
      expect(saveOptions.metadata.lockUntil).toBeTruthy();
      expect(saveOptions.metadata.lockedAt).toBeTruthy();
      expect(saveOptions.metadata.lockedBy).toBe('test-host');
      expect(saveOptions.metadata.lockName).toBe('test-lock');
    });

    it('object exists: exists=true → returns false (no save)', async () => {
      mockFile.exists.mockResolvedValue([true]);

      const result = await accessor.insertRecord(defaultConfig);

      expect(result).toBe(false);
      expect(mockFile.save).not.toHaveBeenCalled();
    });

    it('concurrent create: save throws 412 → returns false', async () => {
      mockFile.exists.mockResolvedValue([false]);
      mockFile.save.mockRejectedValue(gcsError(412));

      const result = await accessor.insertRecord(defaultConfig);

      expect(result).toBe(false);
    });

    it('save throws 500 → propagates', async () => {
      mockFile.exists.mockResolvedValue([false]);
      mockFile.save.mockRejectedValue(gcsError(500));

      await expect(accessor.insertRecord(defaultConfig)).rejects.toThrow();
    });
  });

  describe('updateRecord', () => {
    beforeEach(() => {
      ClockProvider.setClock(() => 5000);
    });

    afterEach(() => {
      ClockProvider.resetClock();
    });

    it('happy path: getMetadata returns expired record → save with generationMatch → true', async () => {
      mockFile.getMetadata.mockResolvedValue([
        { generation: '1', metadata: { lockUntil: '1970-01-01T00:00:01.000Z' } },
      ]);
      mockFile.save.mockResolvedValue(undefined);

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(true);
      expect(mockFile.save).toHaveBeenCalledTimes(1);
      const saveOptions = mockFile.save.mock.calls[0][1];
      expect(saveOptions.preconditionOpts.ifGenerationMatch).toBe(1);
    });

    it('still locked: lockUntil in future → returns false (no save)', async () => {
      mockFile.getMetadata.mockResolvedValue([
        { generation: '1', metadata: { lockUntil: '1970-01-01T00:00:10.000Z' } },
      ]);

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(false);
      expect(mockFile.save).not.toHaveBeenCalled();
    });

    it('missing record: getMetadata throws 404 → throws (triggers cache clear)', async () => {
      mockFile.getMetadata.mockRejectedValue(gcsError(404));

      await expect(accessor.updateRecord(defaultConfig)).rejects.toThrow('Lock record not found');
    });

    it('concurrent modify: save throws 412 → returns false', async () => {
      mockFile.getMetadata.mockResolvedValue([
        { generation: '1', metadata: { lockUntil: '1970-01-01T00:00:01.000Z' } },
      ]);
      mockFile.save.mockRejectedValue(gcsError(412));

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(false);
    });

    it('corrupt metadata: missing lockUntil → throws LockException', async () => {
      mockFile.getMetadata.mockResolvedValue([{ generation: '1', metadata: {} }]);

      await expect(accessor.updateRecord(defaultConfig)).rejects.toThrow('Corrupted lock record');
    });
  });

  describe('unlock', () => {
    it('happy path: getMetadata → setMetadata succeeds → resolves', async () => {
      mockFile.getMetadata.mockResolvedValue([
        {
          generation: '1',
          metadata: {
            lockUntil: '1970-01-01T00:00:10.000Z',
            lockedAt: '1970-01-01T00:00:00.000Z',
            lockedBy: 'test-host',
            lockName: 'test-lock',
          },
        },
      ]);
      mockFile.setMetadata.mockResolvedValue([{}]);

      await accessor.unlock(defaultConfig);

      expect(mockFile.setMetadata).toHaveBeenCalledTimes(1);
      const [meta, options] = mockFile.setMetadata.mock.calls[0];
      expect(options.preconditionOpts.ifGenerationMatch).toBe(1);
      expect(meta.lockUntil).toBeTruthy();
    });

    it('missing record: getMetadata throws 404 → no-op resolves', async () => {
      mockFile.getMetadata.mockRejectedValue(gcsError(404));

      await accessor.unlock(defaultConfig);

      expect(mockFile.setMetadata).not.toHaveBeenCalled();
    });

    it('concurrent modify: setMetadata throws 412 → no-op resolves', async () => {
      mockFile.getMetadata.mockResolvedValue([
        { generation: '1', metadata: { lockUntil: '1970-01-01T00:00:10.000Z' } },
      ]);
      mockFile.setMetadata.mockRejectedValue(gcsError(412));

      await accessor.unlock(defaultConfig);

      expect(mockFile.setMetadata).toHaveBeenCalledTimes(1);
    });
  });

  describe('extend', () => {
    beforeEach(() => {
      ClockProvider.setClock(() => 5000);
    });

    afterEach(() => {
      ClockProvider.resetClock();
    });

    it('happy path: matching lockedBy + future lockUntil → setMetadata succeeds → true', async () => {
      mockFile.getMetadata.mockResolvedValue([
        {
          generation: '2',
          metadata: {
            lockUntil: '1970-01-01T00:00:10.000Z',
            lockedBy: 'test-host',
            lockedAt: '1970-01-01T00:00:00.000Z',
            lockName: 'test-lock',
          },
        },
      ]);
      mockFile.setMetadata.mockResolvedValue([{}]);

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(true);
      expect(mockFile.setMetadata).toHaveBeenCalledTimes(1);
      const [meta, options] = mockFile.setMetadata.mock.calls[0];
      expect(options.preconditionOpts.ifGenerationMatch).toBe(2);
      expect(meta.lockedAt).toBe('1970-01-01T00:00:00.000Z');
      expect(meta.lockedBy).toBe('test-host');
    });

    it('wrong owner: lockedBy mismatch → returns false (no setMetadata)', async () => {
      mockFile.getMetadata.mockResolvedValue([
        {
          generation: '1',
          metadata: {
            lockUntil: '1970-01-01T00:00:10.000Z',
            lockedBy: 'other-host',
          },
        },
      ]);

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
      expect(mockFile.setMetadata).not.toHaveBeenCalled();
    });

    it('expired: lockUntil in past → returns false', async () => {
      mockFile.getMetadata.mockResolvedValue([
        {
          generation: '1',
          metadata: {
            lockUntil: '1970-01-01T00:00:01.000Z',
            lockedBy: 'test-host',
          },
        },
      ]);

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
      expect(mockFile.setMetadata).not.toHaveBeenCalled();
    });

    it('missing record: getMetadata throws 404 → returns false', async () => {
      mockFile.getMetadata.mockRejectedValue(gcsError(404));

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
    });

    it('concurrent modify: setMetadata 412 → returns false', async () => {
      mockFile.getMetadata.mockResolvedValue([
        {
          generation: '1',
          metadata: {
            lockUntil: '1970-01-01T00:00:10.000Z',
            lockedBy: 'test-host',
            lockedAt: '1970-01-01T00:00:00.000Z',
            lockName: 'test-lock',
          },
        },
      ]);
      mockFile.setMetadata.mockRejectedValue(gcsError(412));

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
    });
  });
});
