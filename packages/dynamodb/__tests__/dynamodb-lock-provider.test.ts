import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ClockProvider, createLockConfig, Utils } from '@tslock/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBLockProvider } from '../src/dynamodb-lock-provider.js';

function makeClient(overrides: Record<string, unknown> = {}): DynamoDBClient {
  return {
    send: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as DynamoDBClient;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('DynamoDBLockProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lock() returns a lock on success', async () => {
    const client = makeClient();
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
  });

  it('lock() returns undefined when condition fails', async () => {
    const client = makeClient({
      send: vi.fn().mockRejectedValue(new ConditionalCheckFailedException({ message: 'cond fail', $metadata: {} })),
    });
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() propagates non-conditional errors', async () => {
    const client = makeClient({ send: vi.fn().mockRejectedValue(new Error('network')) });
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    await expect(provider.lock(config())).rejects.toThrow('network');
  });

  it('lock() passes correct ConditionExpression', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = makeClient({ send });
    ClockProvider.setClock(() => 5_000_000);
    const provider = new DynamoDBLockProvider({ tableName: 'my-table', client });
    await provider.lock(createLockConfig('my-lock', 10_000));
    const cmd = send.mock.calls[0]![0];
    expect(cmd.input.TableName).toBe('my-table');
    expect(cmd.input.ConditionExpression).toContain('lockUntil <= :lockedAt');
    expect(cmd.input.ConditionExpression).toContain('attribute_not_exists(lockUntil)');
    expect(cmd.input.Key._id.S).toBe('my-lock');
  });

  it('lock() with sortKey includes sort key in Key', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = makeClient({ send });
    const provider = new DynamoDBLockProvider({
      tableName: 'locks',
      client,
      partitionKey: 'pk',
      sortKey: { name: 'sk', value: 'global' },
    });
    await provider.lock(config());
    const cmd = send.mock.calls[0]![0];
    expect(cmd.input.Key.pk.S).toBe('test');
    expect(cmd.input.Key.sk.S).toBe('global');
  });

  it('unlock() sets unlockTime only when lockedBy matches this host', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const send = vi.fn().mockResolvedValue({});
    const client = makeClient({ send });
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = (await provider.lock(config('report-job', 60_000, 5_000)))!;

    send.mockClear();
    await lock.unlock();

    const cmd = send.mock.calls[0]![0];
    expect(cmd.input.ConditionExpression).toBe('lockedBy = :lockedBy');
    expect(cmd.input.ExpressionAttributeValues[':lockedBy']).toEqual({ S: 'this-host' });
    expect(cmd.input.ExpressionAttributeValues[':unlockTime']).toEqual({ S: '1970-01-01T00:16:45.000Z' });
    expect(cmd.input.UpdateExpression).toBe('SET lockUntil = :unlockTime');
    expect(cmd.input.Key._id.S).toBe('report-job');
    expect(cmd.input.ExpressionAttributeNames).toBeUndefined();
  });

  it('unlock() resolves without a write when a different host holds the item', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'cond fail', $metadata: {} }));
    const client = makeClient({ send });
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    const cmd = send.mock.calls[1]![0];
    expect(cmd.input.ConditionExpression).toBe('lockedBy = :lockedBy');
    expect(cmd.input.ExpressionAttributeValues[':lockedBy']).toEqual({ S: 'this-host' });
  });

  it('unlock() works', async () => {
    const client = makeClient();
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = (await provider.lock(config()))!;
    await lock.unlock();
  });

  it('extend() returns new lock on success', async () => {
    const client = makeClient();
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
  });

  it('extend() returns undefined when condition fails', async () => {
    const client = makeClient({
      send: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'cond fail', $metadata: {} })),
    });
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client });
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });
});
