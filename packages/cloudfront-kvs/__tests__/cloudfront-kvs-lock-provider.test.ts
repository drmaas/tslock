import { ClockProvider, LockException, createLockConfig } from '@tslock/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCloudFrontKvsConfiguration } from '../src/cloudfront-kvs-configuration.js';
import { CloudFrontKvsLockProvider } from '../src/cloudfront-kvs-lock-provider.js';
import { encodeLockRecord } from '../src/lock-record.js';

function awsError(name: string, httpStatusCode: number): Error {
  const e = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  e.name = name;
  e.$metadata = { httpStatusCode };
  return e;
}

function mockClient() {
  return { send: vi.fn() };
}

describe('resolveCloudFrontKvsConfiguration', () => {
  it('merges defaults', () => {
    const client = mockClient() as never;
    const cfg = resolveCloudFrontKvsConfiguration({
      client,
      kvsArn: 'arn:aws:cloudfront::123:key-value-store/abc',
    });
    expect(cfg.keyPrefix).toBe('tslock/');
    expect(cfg.maxEtagRetries).toBe(3);
  });

  it('rejects missing kvsArn', () => {
    expect(() => resolveCloudFrontKvsConfiguration({ client: mockClient() as never, kvsArn: '' })).toThrow(
      LockException,
    );
  });
});

describe('CloudFrontKvsLockProvider', () => {
  let client: { send: ReturnType<typeof vi.fn> };
  let provider: CloudFrontKvsLockProvider;

  beforeEach(() => {
    client = mockClient();
    provider = new CloudFrontKvsLockProvider({
      client: client as never,
      kvsArn: 'arn:aws:cloudfront::123:key-value-store/abc',
    });
    ClockProvider.resetClock();
    ClockProvider.setClock(() => 1_000_000);
  });

  it('acquires when key is absent', async () => {
    client.send
      .mockResolvedValueOnce({ ETag: 'etag-1' })
      .mockRejectedValueOnce(awsError('ResourceNotFoundException', 404))
      .mockResolvedValueOnce({ ETag: 'etag-2', ItemCount: 1, TotalSizeInBytes: 10 });

    const lock = await provider.lock(createLockConfig('job', 60_000));
    expect(lock).toBeDefined();
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('returns undefined when lock is held', async () => {
    client.send.mockResolvedValueOnce({ ETag: 'etag-1' }).mockResolvedValueOnce({
      Value: encodeLockRecord({
        lockUntil: new Date(1_100_000).toISOString().replace(/Z$/, '.000Z'),
        lockedAt: new Date(900_000).toISOString().replace(/Z$/, '.000Z'),
        lockedBy: 'other',
      }),
    });

    const lock = await provider.lock(createLockConfig('job', 60_000));
    expect(lock).toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('re-acquires when expired', async () => {
    client.send
      .mockResolvedValueOnce({ ETag: 'etag-1' })
      .mockResolvedValueOnce({
        Value: encodeLockRecord({
          lockUntil: new Date(900_000).toISOString().replace(/Z$/, '.000Z'),
          lockedAt: new Date(800_000).toISOString().replace(/Z$/, '.000Z'),
          lockedBy: 'other',
        }),
      })
      .mockResolvedValueOnce({ ETag: 'etag-2' });

    const lock = await provider.lock(createLockConfig('job', 60_000));
    expect(lock).toBeDefined();
  });

  it('retries on ConflictException then succeeds', async () => {
    client.send
      .mockResolvedValueOnce({ ETag: 'etag-1' })
      .mockRejectedValueOnce(awsError('ResourceNotFoundException', 404))
      .mockRejectedValueOnce(awsError('ConflictException', 409))
      .mockResolvedValueOnce({ ETag: 'etag-2' })
      .mockRejectedValueOnce(awsError('ResourceNotFoundException', 404))
      .mockResolvedValueOnce({ ETag: 'etag-3' });

    const lock = await provider.lock(createLockConfig('job', 60_000));
    expect(lock).toBeDefined();
  });

  it('returns undefined after exhausting ETag retries', async () => {
    const p = new CloudFrontKvsLockProvider({
      client: client as never,
      kvsArn: 'arn:aws:cloudfront::123:key-value-store/abc',
      maxEtagRetries: 2,
    });
    client.send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DescribeKeyValueStoreCommand') return { ETag: 'e' };
      if (cmd.constructor.name === 'GetKeyCommand') throw awsError('ResourceNotFoundException', 404);
      throw awsError('ConflictException', 409);
    });

    const lock = await p.lock(createLockConfig('job', 60_000));
    expect(lock).toBeUndefined();
  });

  it('propagates non-conflict put errors', async () => {
    client.send
      .mockResolvedValueOnce({ ETag: 'etag-1' })
      .mockRejectedValueOnce(awsError('ResourceNotFoundException', 404))
      .mockRejectedValueOnce(new Error('network'));

    await expect(provider.lock(createLockConfig('job', 60_000))).rejects.toThrow('network');
  });

  it('unlocks by overwriting lockUntil', async () => {
    client.send
      .mockResolvedValueOnce({ ETag: 'etag-1' })
      .mockRejectedValueOnce(awsError('ResourceNotFoundException', 404))
      .mockResolvedValueOnce({ ETag: 'etag-2' });
    const held = await provider.lock(createLockConfig('job', 60_000));
    expect(held).toBeDefined();

    client.send
      .mockResolvedValueOnce({ ETag: 'etag-3' })
      .mockResolvedValueOnce({
        Value: encodeLockRecord({
          lockUntil: '1970-01-01T00:17:40.000Z',
          lockedAt: '1970-01-01T00:16:40.000Z',
          lockedBy: 'host',
        }),
      })
      .mockResolvedValueOnce({ ETag: 'etag-4' });

    await held!.unlock();
    const putCmd = client.send.mock.calls.at(-1)?.[0] as { input: { Value: string } };
    expect(JSON.parse(putCmd.input.Value).lockUntil).toBeTruthy();
  });

  it('extend rejects different owner', async () => {
    client.send.mockResolvedValueOnce({ ETag: 'etag-1' }).mockResolvedValueOnce({
      Value: encodeLockRecord({
        lockUntil: '1970-01-01T00:18:20.000Z',
        lockedAt: '1970-01-01T00:16:40.000Z',
        lockedBy: 'someone-else',
      }),
    });

    const result = await provider.extend(createLockConfig('job', 60_000));
    expect(result).toBeUndefined();
  });
});
