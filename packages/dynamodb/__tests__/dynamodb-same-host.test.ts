import { ConditionalCheckFailedException, type DynamoDBClient, type UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ClockProvider, createLockConfig, lockAtMostUntil, Utils } from '@tslock/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBAccessor } from '../src/dynamodb-accessor.js';
import { DynamoDBLockProvider } from '../src/dynamodb-lock-provider.js';

type AttributeValues = Record<string, { S?: string }>;

function stringValue(values: AttributeValues | undefined, token: string): string | undefined {
  return values?.[token]?.S;
}

function clauseHolds(
  clause: string,
  values: AttributeValues | undefined,
  item: Record<string, string> | undefined,
): boolean {
  if (clause === 'attribute_not_exists(lockUntil)') return item?.lockUntil === undefined;
  const pieces = clause.match(/^(\w+) (<=|=|>) (:\w+)$/);
  if (!pieces) throw new Error(`unparsed condition: ${clause}`);
  const left = item?.[pieces[1] ?? ''];
  const right = stringValue(values, pieces[3] ?? '');
  if (left === undefined || right === undefined) return false;
  if (pieces[2] === '=') return left === right;
  if (pieces[2] === '<=') return left <= right;
  if (pieces[2] === '>') return left > right;
  return false;
}

function conditionHolds(
  expression: string | undefined,
  values: AttributeValues | undefined,
  item: Record<string, string> | undefined,
): boolean {
  if (!expression) return true;
  return expression.split(' OR ').some((orPart) =>
    orPart
      .trim()
      .split(' AND ')
      .every((clause) => clauseHolds(clause.trim(), values, item)),
  );
}

function applySet(item: Record<string, string>, update: string | undefined, values: AttributeValues | undefined): void {
  if (!update?.startsWith('SET ')) throw new Error(`unparsed update: ${update}`);
  for (const assignment of update.slice(4).split(', ')) {
    const pieces = assignment.split(' = ');
    if (pieces.length !== 2) throw new Error(`unparsed assignment: ${assignment}`);
    const field = pieces[0]?.trim();
    const value = stringValue(values, pieces[1]?.trim() ?? '');
    if (!field || value === undefined) throw new Error(`missing value for ${assignment}`);
    item[field] = value;
  }
}

class MemoryDynamo {
  readonly items = new Map<string, Record<string, string>>();
  readonly commands: UpdateItemCommand[] = [];

  readonly send = async (command: UpdateItemCommand): Promise<Record<string, never>> => {
    this.commands.push(command);
    const input = command.input;
    const name = input.Key?._id?.S;
    if (!name) throw new Error('missing _id');
    const values = input.ExpressionAttributeValues as AttributeValues | undefined;
    const current = this.items.get(name);
    if (!conditionHolds(input.ConditionExpression, values, current)) {
      throw new ConditionalCheckFailedException({ message: 'cond fail', $metadata: {} });
    }
    const next = { ...(current ?? {}) };
    applySet(next, input.UpdateExpression, values);
    this.items.set(name, next);
    return {};
  };

  client(): DynamoDBClient {
    return { send: this.send } as unknown as DynamoDBClient;
  }
}

describe('DynamoDB same-host ownership', () => {
  afterEach(() => {
    ClockProvider.resetClock();
    vi.restoreAllMocks();
  });

  it('does not unlock or extend a newer lock acquired by the same host', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const table = new MemoryDynamo();
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client: table.client() });
    const unlockConfig = createLockConfig('unlock-job', 5_000);
    const unlockLock = await provider.lock(unlockConfig);
    expect(unlockLock).toBeDefined();
    now = 1_006_000;
    expect(await provider.lock(createLockConfig('unlock-job', 60_000))).toBeDefined();
    const unlockHeld = table.items.get('unlock-job')?.lockUntil;
    const unlockAcquired = Utils.toIsoString(lockAtMostUntil(unlockConfig));
    await unlockLock?.unlock();

    now = 1_000_000;
    const extendConfig = createLockConfig('extend-job', 5_000);
    const extendLock = await provider.lock(extendConfig);
    expect(extendLock).toBeDefined();
    now = 1_006_000;
    expect(await provider.lock(createLockConfig('extend-job', 60_000))).toBeDefined();
    const extendHeld = table.items.get('extend-job')?.lockUntil;
    const extendAcquired = Utils.toIsoString(lockAtMostUntil(extendConfig));
    expect(await extendLock?.extend(120_000, 0)).toBeUndefined();

    expect(table.items.get('unlock-job')?.lockUntil).toBe(unlockHeld);
    expect(table.items.get('unlock-job')?.lockedBy).toBe('host-a');
    expect(table.items.get('extend-job')?.lockUntil).toBe(extendHeld);
    expect(table.items.get('extend-job')?.lockedBy).toBe('host-a');
    const unlock = table.commands.find(
      (command) =>
        command.input.Key?._id?.S === 'unlock-job' && command.input.UpdateExpression === 'SET lockUntil = :unlockTime',
    );
    const extend = table.commands.find(
      (command) =>
        command.input.Key?._id?.S === 'extend-job' && command.input.UpdateExpression === 'SET lockUntil = :lockUntil',
    );
    expect(unlock?.input.ConditionExpression).toBe('lockedBy = :lockedBy AND lockUntil = :expectedLockUntil');
    expect(unlock?.input.ExpressionAttributeValues?.[':expectedLockUntil']?.S).toBe(unlockAcquired);
    expect(unlock?.input.ExpressionAttributeValues?.[':expectedLockUntil']?.S).not.toBe(unlockHeld);
    expect(extend?.input.ConditionExpression).toContain('lockUntil = :expectedLockUntil');
    expect(extend?.input.ConditionExpression).toContain('lockUntil > :now');
    expect(extend?.input.ExpressionAttributeValues?.[':expectedLockUntil']?.S).toBe(extendAcquired);
    expect(extend?.input.ExpressionAttributeValues?.[':expectedLockUntil']?.S).not.toBe(extendHeld);
  });

  it('unlocks and extends when the stored deadline matches', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    ClockProvider.setClock(() => 1_000_000);
    const table = new MemoryDynamo();
    const provider = new DynamoDBLockProvider({ tableName: 'locks', client: table.client() });
    const config = createLockConfig('job', 60_000, 5_000);
    const lock = await provider.lock(config);
    expect(lock).toBeDefined();

    const extended = await lock?.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(table.items.get('job')?.lockUntil).toBe('1970-01-01T00:18:40.000Z');
    expect(table.commands[1]?.input.ConditionExpression).toContain('lockUntil = :expectedLockUntil');
    expect(table.commands[1]?.input.ExpressionAttributeValues?.[':expectedLockUntil']?.S).toBe(
      Utils.toIsoString(lockAtMostUntil(config)),
    );

    await extended?.unlock();
    expect(table.items.get('job')?.lockUntil).toBe('1970-01-01T00:16:40.000Z');
  });

  it('extend does not write when the previous deadline is missing', async () => {
    const send = vi.fn();
    const accessor = new DynamoDBAccessor({ send } as unknown as DynamoDBClient, 'locks', '_id');
    ClockProvider.setClock(() => 1_000_000);
    await expect(accessor.extend(createLockConfig('job', 60_000))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates errors other than a failed condition', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('network'));
    const provider = new DynamoDBLockProvider({
      tableName: 'locks',
      client: { send } as unknown as DynamoDBClient,
    });
    ClockProvider.setClock(() => 1_000_000);
    const lock = await provider.lock(createLockConfig('job', 60_000));
    await expect(lock?.unlock()).rejects.toThrow('network');

    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('network'));
    const again = await provider.lock(createLockConfig('job', 60_000));
    await expect(again?.extend(120_000, 0)).rejects.toThrow('network');
  });
});
