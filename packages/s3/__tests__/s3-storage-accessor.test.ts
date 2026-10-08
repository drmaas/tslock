import { createHash } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand, type S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { ClockProvider } from '@tslock/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3ProviderConfig } from '../src/s3-provider-config.js';
import { createS3ProviderConfig } from '../src/s3-provider-config.js';
import { S3StorageAccessor } from '../src/s3-storage-accessor.js';

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
      const putCmd = mockSend.mock.calls[1]![0];
      expect(putCmd.input.IfNoneMatch).toBe('*');
      expect(putCmd.input.Bucket).toBe('test-bucket');
      expect(putCmd.input.Metadata.lockUntil).toBeTruthy();
      expect(JSON.parse(String(putCmd.input.Body))).toEqual({
        lockUntil: putCmd.input.Metadata.lockUntil,
        lockedAt: putCmd.input.Metadata.lockedAt,
        lockedBy: putCmd.input.Metadata.lockedBy,
      });
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

    it('concurrent create: PutObject 409 → returns false', async () => {
      mockSend
        .mockRejectedValueOnce(mockS3Error('NotFound', 404))
        .mockRejectedValueOnce(mockS3Error('ConditionalRequestConflict', 409));

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
      const putCmd = mockSend.mock.calls[1]![0];
      expect(putCmd.input.IfMatch).toBe('"etag1"');
      expect(JSON.parse(String(putCmd.input.Body))).toEqual({
        lockUntil: putCmd.input.Metadata.lockUntil,
        lockedAt: putCmd.input.Metadata.lockedAt,
        lockedBy: putCmd.input.Metadata.lockedBy,
      });
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

      await expect(accessor.updateRecord(defaultConfig)).rejects.toThrow('Lock record not found');
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

    it('concurrent modify: PutObject 409 → returns false', async () => {
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: { lockuntil: '1970-01-01T00:00:01.000Z' },
          $metadata: { httpStatusCode: 200 },
        })
        .mockRejectedValueOnce(mockS3Error('Conflict', 409));

      const result = await accessor.updateRecord(defaultConfig);

      expect(result).toBe(false);
    });

    it('corrupt metadata: missing lockUntil → throws LockException', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {},
        $metadata: { httpStatusCode: 200 },
      });

      await expect(accessor.updateRecord(defaultConfig)).rejects.toThrow('Corrupted lock record');
    });
  });

  describe('unlock', () => {
    beforeEach(() => {
      vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host1');
    });

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
      const putCmd = mockSend.mock.calls[1]![0];
      expect(putCmd).toBeInstanceOf(PutObjectCommand);
      expect(putCmd.input.IfMatch).toBe('"etag1"');
      expect(putCmd.input.Metadata.lockUntil).toBeTruthy();
      expect(JSON.parse(String(putCmd.input.Body))).toEqual({
        lockUntil: putCmd.input.Metadata.lockUntil,
        lockedAt: putCmd.input.Metadata.lockedAt,
        lockedBy: putCmd.input.Metadata.lockedBy,
      });
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
          Metadata: { lockuntil: '1970-01-01T00:00:10.000Z', lockedby: 'host1' },
          $metadata: { httpStatusCode: 200 },
        })
        .mockRejectedValueOnce(mockS3Error('PreconditionFailed', 412));

      await accessor.unlock(defaultConfig);

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('concurrent modify: PutObject 409 → no-op resolves', async () => {
      mockSend
        .mockResolvedValueOnce({
          ETag: '"etag1"',
          Metadata: { lockuntil: '1970-01-01T00:00:10.000Z', lockedby: 'host1' },
          $metadata: { httpStatusCode: 200 },
        })
        .mockRejectedValueOnce(mockS3Error('Conflict', 409));

      await accessor.unlock(defaultConfig);

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('different owner: no PutObjectCommand and resolves', async () => {
      mockSend.mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {
          lockuntil: '1970-01-01T00:00:10.000Z',
          lockedat: '1970-01-01T00:00:00.000Z',
          lockedby: 'other-host',
        },
        $metadata: { httpStatusCode: 200 },
      });

      await expect(accessor.unlock(defaultConfig)).resolves.toBeUndefined();

      expect(mockSend.mock.calls.some((call) => call[0] instanceof PutObjectCommand)).toBe(false);
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
      vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host1');
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
      const putCmd = mockSend.mock.calls[1]![0];
      expect(putCmd.input.IfMatch).toBe('"etag1"');
      expect(JSON.parse(String(putCmd.input.Body))).toEqual({
        lockUntil: putCmd.input.Metadata.lockUntil,
        lockedAt: putCmd.input.Metadata.lockedAt,
        lockedBy: putCmd.input.Metadata.lockedBy,
      });
    });

    it('wrong owner: lockedBy mismatch → returns false', async () => {
      vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host2');
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
      vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host1');
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
      vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host1');
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

    it('concurrent modify: PutObject 409 → returns false', async () => {
      vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host1');
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
        .mockRejectedValueOnce(mockS3Error('Conflict', 409));

      const result = await accessor.extend(defaultConfig);

      expect(result).toBe(false);
    });
  });
});

type StoredObject = { body: string; metadata: Record<string, string>; etag: string };

function sseS3Etag(body: string): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}

function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body === undefined) return '';
  throw new Error(`unexpected S3 body type: ${typeof body}`);
}

function lowercaseMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    stored[key.toLowerCase()] = value;
  }
  return stored;
}

function metadataValue(metadata: Record<string, string>, key: string): string | undefined {
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function createSseS3Client(): {
  client: S3Client;
  store: Map<string, StoredObject>;
  preconditionFailures: string[];
  dispatch: (command: unknown) => Promise<unknown>;
} {
  const store = new Map<string, StoredObject>();
  const preconditionFailures: string[] = [];

  async function dispatch(command: unknown): Promise<unknown> {
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key;
      if (!key) throw new Error('HeadObject missing key');
      const object = store.get(key);
      if (!object) throw mockS3Error('NotFound', 404);
      return {
        ETag: object.etag,
        Metadata: { ...object.metadata },
        $metadata: { httpStatusCode: 200 },
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (!key) throw new Error('PutObject missing key');
      const existing = store.get(key);
      if (command.input.IfNoneMatch === '*' && existing) {
        preconditionFailures.push('*');
        throw mockS3Error('PreconditionFailed', 412);
      }
      if (command.input.IfMatch !== undefined && (!existing || existing.etag !== command.input.IfMatch)) {
        preconditionFailures.push(command.input.IfMatch);
        throw mockS3Error('PreconditionFailed', 412);
      }
      const body = bodyToString(command.input.Body);
      const object = { body, metadata: lowercaseMetadata(command.input.Metadata), etag: sseS3Etag(body) };
      store.set(key, object);
      return { ETag: object.etag, $metadata: { httpStatusCode: 200 } };
    }
    throw new Error('unexpected S3 command');
  }

  const client = { send: (command: unknown) => dispatch(command) } as unknown as S3Client;
  return { client, store, preconditionFailures, dispatch };
}

describe('S3StorageAccessor SSE-S3 ETag', () => {
  const objectKey = 'shedlock/test-lock';

  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('changes the ETag when update and extend change lockedBy or lockUntil', async () => {
    const sse = createSseS3Client();
    const accessor = new S3StorageAccessor(sse.client, createS3ProviderConfig({ bucket: 'test-bucket' }));
    vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host-a');
    ClockProvider.setClock(() => 0);

    await accessor.insertRecord({ name: 'test-lock', lockAtMostFor: 1_000, lockAtLeastFor: 0, createdAt: 0 });
    const inserted = sse.store.get(objectKey);
    expect(inserted?.etag).toBe(sseS3Etag(inserted?.body ?? ''));
    expect(inserted?.etag).not.toBe(sseS3Etag(''));

    ClockProvider.setClock(() => 5_000);
    vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host-b');
    const updated = await accessor.updateRecord({
      name: 'test-lock',
      lockAtMostFor: 20_000,
      lockAtLeastFor: 0,
      createdAt: 5_000,
    });
    const afterUpdate = sse.store.get(objectKey);
    expect(updated).toBe(true);
    expect(afterUpdate?.etag).not.toBe(inserted?.etag);
    expect(metadataValue(afterUpdate?.metadata ?? {}, 'lockedBy')).toBe('host-b');
    expect(JSON.parse(afterUpdate?.body ?? '{}')).toMatchObject({
      lockedBy: 'host-b',
      lockUntil: metadataValue(afterUpdate?.metadata ?? {}, 'lockUntil'),
    });

    const extended = await accessor.extend({
      name: 'test-lock',
      lockAtMostFor: 30_000,
      lockAtLeastFor: 0,
      createdAt: 5_000,
    });
    const afterExtend = sse.store.get(objectKey);
    expect(extended).toBe(true);
    expect(afterExtend?.etag).not.toBe(afterUpdate?.etag);
    expect(metadataValue(afterExtend?.metadata ?? {}, 'lockedBy')).toBe('host-b');
    expect(metadataValue(afterExtend?.metadata ?? {}, 'lockUntil')).toBe('1970-01-01T00:00:35.000Z');

    const extendedAgain = await accessor.extend({
      name: 'test-lock',
      lockAtMostFor: 40_000,
      lockAtLeastFor: 0,
      createdAt: 5_000,
    });
    const afterSecondExtend = sse.store.get(objectKey);
    expect(extendedAgain).toBe(true);
    expect(afterSecondExtend?.etag).not.toBe(afterExtend?.etag);
    expect(metadataValue(afterSecondExtend?.metadata ?? {}, 'lockUntil')).toBe('1970-01-01T00:00:45.000Z');
  });

  it('reads lock state from metadata when the object body is empty', async () => {
    const sse = createSseS3Client();
    const accessor = new S3StorageAccessor(sse.client, createS3ProviderConfig({ bucket: 'test-bucket' }));
    vi.spyOn(accessor as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host1');
    sse.store.set('shedlock/legacy', {
      body: '',
      etag: sseS3Etag(''),
      metadata: {
        lockuntil: '1970-01-01T00:00:01.000Z',
        lockedat: '1970-01-01T00:00:00.000Z',
        lockedby: 'previous',
      },
    });
    ClockProvider.setClock(() => 5_000);

    const updated = await accessor.updateRecord({
      name: 'legacy',
      lockAtMostFor: 10_000,
      lockAtLeastFor: 0,
      createdAt: 5_000,
    });

    const stored = sse.store.get('shedlock/legacy');
    expect(updated).toBe(true);
    expect(stored?.etag).not.toBe(sseS3Etag(''));
    expect(metadataValue(stored?.metadata ?? {}, 'lockedBy')).toBe('host1');
    expect(JSON.parse(stored?.body ?? '{}').lockUntil).toBe(metadataValue(stored?.metadata ?? {}, 'lockUntil'));
  });

  it('fails a stale unlock when another owner updates between HEAD and PUT', async () => {
    const sse = createSseS3Client();
    let send = sse.dispatch;
    const client = { send: (command: unknown) => send(command) } as unknown as S3Client;
    const owner = new S3StorageAccessor(client, createS3ProviderConfig({ bucket: 'test-bucket' }));
    const intruder = new S3StorageAccessor(client, createS3ProviderConfig({ bucket: 'test-bucket' }));
    vi.spyOn(owner as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host-a');
    vi.spyOn(intruder as unknown as { getHostname: () => string }, 'getHostname').mockReturnValue('host-b');
    ClockProvider.setClock(() => 0);
    await owner.insertRecord({ name: 'test-lock', lockAtMostFor: 1_000, lockAtLeastFor: 0, createdAt: 0 });

    ClockProvider.setClock(() => 5_000);
    const intruderConfig = {
      name: 'test-lock',
      lockAtMostFor: 20_000,
      lockAtLeastFor: 0,
      createdAt: 5_000,
    };
    let etagAtUnlockHead = '';
    let etagAfterIntruder = '';
    let injected = false;
    send = async (command: unknown) => {
      if (!injected && command instanceof HeadObjectCommand) {
        injected = true;
        const head = (await sse.dispatch(command)) as { ETag: string };
        etagAtUnlockHead = head.ETag;
        await intruder.updateRecord(intruderConfig);
        etagAfterIntruder = sse.store.get(objectKey)?.etag ?? '';
        return head;
      }
      return sse.dispatch(command);
    };

    await owner.unlock({ name: 'test-lock', lockAtMostFor: 1_000, lockAtLeastFor: 0, createdAt: 0 });

    const stored = sse.store.get(objectKey);
    expect(etagAfterIntruder).not.toBe(etagAtUnlockHead);
    expect(sse.preconditionFailures).toContain(etagAtUnlockHead);
    expect(stored?.etag).toBe(etagAfterIntruder);
    expect(metadataValue(stored?.metadata ?? {}, 'lockedBy')).toBe('host-b');
    expect(metadataValue(stored?.metadata ?? {}, 'lockUntil')).toBe('1970-01-01T00:00:25.000Z');
    expect(JSON.parse(stored?.body ?? '{}')).toMatchObject({
      lockedBy: 'host-b',
      lockUntil: '1970-01-01T00:00:25.000Z',
    });
  });
});
