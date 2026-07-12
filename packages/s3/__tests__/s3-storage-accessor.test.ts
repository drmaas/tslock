import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S3ServiceException } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { ClockProvider } from '@tslock/core';
import { S3StorageAccessor } from '../src/s3-storage-accessor.js';
import type { S3ProviderConfig } from '../src/s3-provider-config.js';
import { createS3ProviderConfig } from '../src/s3-provider-config.js';

function mockS3Error(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
  });
}

const defaultConfig = {
  name: 'test-lock',
  lockAtMostFor: 10000,
  lockAtLeastFor: 1000,
  createdAt: 0,
};

describe('S3StorageAccessor', () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let s3Client: S3Client;
  let providerConfig: S3ProviderConfig;
  let accessor: S3StorageAccessor;

  beforeEach(() => {
    mockSend = vi.fn();
    s3Client = { send: mockSend } as unknown as S3Client;
    providerConfig = createS3ProviderConfig({
      bucket: 'test-bucket',
    });
    accessor = new S3StorageAccessor(s3Client, providerConfig);
  });

  describe('insertRecord', () => {
    it('happy path: HeadObject 404 → PutObject succeeds → true', async () => {
      mockSend
        .mockRejectedValueOnce(mockS3Error('NotFound', 404))
        .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

      const result = await accessor.insertRecord(defaultConfig);

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCmd = mockSend.mock.calls[1][0];
      expect(putCmd.input.IfNoneMatch).toBe('*');
      expect(putCmd.input.Bucket).toBe('test-bucket');
      expect(putCmd.input.Metadata.lockUntil).toBeTruthy();
    });

    it('object exists: HeadObject succeeds → returns false', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {},
        $metadata: { httpStatusCode: 200 },
      });

      const result = await accessor.insertRecord(defaultConfig);

      expect(result).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('concurrent create: PutObject 412 → returns false', async () => {
      mockSend
        .mockRejectedValueOnce(mockS3Error('NotFound', 404))
        .mockRejectedValueOnce(mockS3Error('PreconditionFailed', 412));

      const result = await accessor.insertRecord(defaultConfig);

      expect(result).toBe(false);
    });

    it('HeadObject throws 500 → propagates', async () => {
      mockSend.mockRejectedValueOnce(mockS3Error('InternalError', 500));

      await expect(accessor.insertRecord(defaultConfig)).rejects.toThrow();
    });

    it('PutObject throws 500 → propagates', async () => {
      mockSend
        .mockRejectedValueOnce(mockS3Error('NotFound', 404))
        .mockRejectedValueOnce(mockS3Error('InternalError', 500));

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

    it('happy path: HeadObject returns expired lock → PutObject IfMatch succeeds → true', async () => {
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: { lockuntil: '1970-01-01T00:00:01.000Z' },
          $metadata: { httpStatusCode: 200 },
        })
        .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCmd = mockSend.mock.calls[1][0];
      expect(putCmd.input.IfMatch).toBe('"etag1"');
    });

    it('still locked: lockUntil in future → returns false', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: { lockuntil: '1970-01-01T00:00:10.000Z' },
        $metadata: { httpStatusCode: 200 },
      });

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('missing record: HeadObject 404 → throws (triggers cache clear)', async () => {
      mockSend.mockRejectedValueOnce(mockS3Error('NotFound', 404));

      await expect(accessor.updateRecord(defaultConfig)).rejects.toThrow(
        'Lock record not found',
      );
    });

    it('concurrent modify: PutObject 412 → returns false', async () => {
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: { lockuntil: '1970-01-01T00:00:01.000Z' },
          $metadata: { httpStatusCode: 200 },
        })
        .mockRejectedValueOnce(mockS3Error('PreconditionFailed', 412));

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(false);
    });

    it('corrupt metadata: missing lockUntil → throws LockException', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {},
        $metadata: { httpStatusCode: 200 },
      });

      await expect(accessor.updateRecord(defaultConfig)).rejects.toThrow(
        'Corrupted lock record',
      );
    });
  });

  describe('unlock', () => {
    it('happy path: HeadObject → PutObject IfMatch succeeds → resolves', async () => {
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: {
            lockuntil: '1970-01-01T00:00:10.000Z',
            lockedat: '1970-01-01T00:00:00.000Z',
            lockedby: 'host1',
          },
          $metadata: { httpStatusCode: 200 },
        })
        .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

      await accessor.unlock(defaultConfig);

      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCmd = mockSend.mock.calls[1][0];
      expect(putCmd.input.IfMatch).toBe('"etag1"');
    });

    it('missing record: HeadObject 404 → no-op resolves', async () => {
      mockSend.mockRejectedValueOnce(mockS3Error('NotFound', 404));

      await accessor.unlock(defaultConfig);

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('concurrent modify: PutObject 412 → no-op resolves', async () => {
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: { lockuntil: '1970-01-01T00:00:10.000Z' },
          $metadata: { httpStatusCode: 200 },
        })
        .mockRejectedValueOnce(mockS3Error('PreconditionFailed', 412));

      await accessor.unlock(defaultConfig);

      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('extend', () => {
    beforeEach(() => {
      ClockProvider.setClock(() => 5000);
    });

    afterEach(() => {
      ClockProvider.resetClock();
    });

    it('happy path: matching lockedBy + future lockUntil → PutObject succeeds → true', async () => {
      vi.spyOn(accessor, 'getHostname' as any).mockReturnValue('host1');
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: {
            lockuntil: '1970-01-01T00:00:10.000Z',
            lockedby: 'host1',
            lockedat: '1970-01-01T00:00:00.000Z',
          },
          $metadata: { httpStatusCode: 200 },
        })
        .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
      const putCmd = mockSend.mock.calls[1][0];
      expect(putCmd.input.IfMatch).toBe('"etag1"');
    });

    it('wrong owner: lockedBy mismatch → returns false', async () => {
      vi.spyOn(accessor, 'getHostname' as any).mockReturnValue('host2');
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {
          lockuntil: '1970-01-01T00:00:10.000Z',
          lockedby: 'host1',
        },
        $metadata: { httpStatusCode: 200 },
      });

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('expired: lockUntil in past → returns false', async () => {
      vi.spyOn(accessor, 'getHostname' as any).mockReturnValue('host1');
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {
          lockuntil: '1970-01-01T00:00:01.000Z',
          lockedby: 'host1',
        },
        $metadata: { httpStatusCode: 200 },
      });

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('missing record: HeadObject 404 → returns false', async () => {
      mockSend.mockRejectedValueOnce(mockS3Error('NotFound', 404));

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
    });

    it('concurrent modify: PutObject 412 → returns false', async () => {
      vi.spyOn(accessor, 'getHostname' as any).mockReturnValue('host1');
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: {
            lockuntil: '1970-01-01T00:00:10.000Z',
            lockedby: 'host1',
            lockedat: '1970-01-01T00:00:00.000Z',
          },
          $metadata: { httpStatusCode: 200 },
        })
        .mockRejectedValueOnce(mockS3Error('PreconditionFailed', 412));

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
    });
  });
});
