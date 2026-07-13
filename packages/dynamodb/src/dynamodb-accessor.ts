import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ClockProvider, type LockConfiguration, lockAtMostUntil, Utils, unlockTime } from '@tslock/core';
import { DynamoDBLock } from './dynamodb-lock.js';

export class DynamoDBAccessor {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
    private readonly partitionKey: string,
    private readonly sortKey?: { name: string; value: string },
  ) {}

  private buildKey(name: string): Record<string, { S: string }> {
    const key: Record<string, { S: string }> = { [this.partitionKey]: { S: name } };
    if (this.sortKey) {
      key[this.sortKey.name] = { S: this.sortKey.value };
    }
    return key;
  }

  async lock(config: LockConfiguration): Promise<DynamoDBLock | undefined> {
    const now = ClockProvider.now();
    const isoNow = Utils.toIsoString(now);
    const isoLockAtMostUntil = Utils.toIsoString(lockAtMostUntil(config));
    const hostname = Utils.getHostname();

    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: this.buildKey(config.name),
          UpdateExpression: 'SET lockUntil = :lockUntil, lockedAt = :lockedAt, lockedBy = :lockedBy',
          ConditionExpression: 'lockUntil <= :lockedAt OR attribute_not_exists(lockUntil)',
          ExpressionAttributeValues: {
            ':lockUntil': { S: isoLockAtMostUntil },
            ':lockedAt': { S: isoNow },
            ':lockedBy': { S: hostname },
          },
        }),
      );
      return new DynamoDBLock(config, this);
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return undefined;
      throw e;
    }
  }

  async extend(config: LockConfiguration): Promise<DynamoDBLock | undefined> {
    const now = ClockProvider.now();
    const isoNow = Utils.toIsoString(now);
    const isoNewLockAtMostUntil = Utils.toIsoString(lockAtMostUntil(config));
    const hostname = Utils.getHostname();

    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: this.buildKey(config.name),
          UpdateExpression: 'SET lockUntil = :lockUntil',
          ConditionExpression: 'lockedBy = :lockedBy AND lockUntil > :now',
          ExpressionAttributeValues: {
            ':lockUntil': { S: isoNewLockAtMostUntil },
            ':lockedBy': { S: hostname },
            ':now': { S: isoNow },
          },
        }),
      );
      return new DynamoDBLock(config, this);
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return undefined;
      throw e;
    }
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const isoUnlock = Utils.toIsoString(unlockTime(config));

    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: this.buildKey(config.name),
          UpdateExpression: 'SET lockUntil = :unlockTime',
          ConditionExpression: `attribute_exists(${this.partitionKey})`,
          ExpressionAttributeValues: {
            ':unlockTime': { S: isoUnlock },
          },
        }),
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return;
      throw e;
    }
  }
}
