# Spec: @tslock/dynamodb

## Overview

The `@tslock/dynamodb` package provides a DIRECT `LockProvider` backed by Amazon DynamoDB via the AWS SDK v3 (`@aws-sdk/client-dynamodb`). Locks are acquired with `UpdateItem` + a `ConditionExpression` that asserts the lock has expired or does not exist. Dates are stored as ISO-8601 strings in DynamoDB string attributes; lexicographic ordering of ISO-8601 matches chronological ordering, so `<=` comparisons on the string attributes are correct. The provider supports a partition key (default `_id`) and an optional sort key for tables that require composite keys.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/dynamodb` |
| **Driver** | `@aws-sdk/client-dynamodb` (AWS SDK v3) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `@aws-sdk/client-dynamodb` (peer) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. DynamoDBLockProvider

```typescript
class DynamoDBLockProvider implements ExtensibleLockProvider {
  constructor(options: DynamoDBLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an options object that includes either a pre-configured `DynamoDBClient` (recommended — user configures region/credentials once) or omits the client to let the provider build a default `DynamoDBClient` from the standard credential chain.

### 2. DynamoDBLockProviderOptions

```typescript
interface DynamoDBLockProviderOptions {
  client?: DynamoDBClient;       // optional — if omitted, a default client is constructed
  tableName: string;              // REQUIRED — must already exist
  partitionKey?: string;          // default: '_id'
  sortKey?: {                     // optional — use if the table has a composite key
    name: string;
    value: string;
  };
}
```

Validation (in the constructor):
- `tableName` must be a non-empty string.
- `partitionKey` defaults to `'_id'`.
- `sortKey`, if provided, must have both `name` and `value` as non-empty strings.

The provider does **not** create the table. Production DynamoDB tables should be provisioned separately via IaC (CDK / Terraform / CloudFormation). For tests, LocalStack or the AWS DynamoDB testcontainer is used to create the table before the suite runs.

### 3. DynamoDBLock

```typescript
class DynamoDBLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

### 4. DynamoDBAccessor (internal)

```typescript
class DynamoDBAccessor {
  constructor(
    client: DynamoDBClient,
    tableName: string,
    partitionKey: string,
    sortKey?: { name: string; value: string },
  );
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  extend(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}
```

## Locking Mechanism

All three operations use `UpdateItemCommand`. The `Key` is built via a helper so the partition+sort-key logic is shared:

```typescript
private buildKey(name: string): Record<string, { S: string }> {
  return this.sortKey
    ? { [this.partitionKey]: { S: name }, [this.sortKey.name]: { S: this.sortKey.value } }
    : { [this.partitionKey]: { S: name } };
}
```

Native `{ S: ... }` attribute literals are used instead of `@aws-sdk/util-dynamodb`'s `marshall` to keep the dependency surface to just `@aws-sdk/client-dynamodb`. All attributes are strings (ISO-8601 dates or hostname).

### lock(config)

Single `UpdateItem` call with a `ConditionExpression` that succeeds only when the lock is expired or absent. ISO-8601 strings stored in string attributes; lexicographic ordering matches chronological ordering for the same format, so `<=` is correct.

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const isoNow = Utils.toIsoString(now);
  const isoLockAtMostUntil = Utils.toIsoString(lockAtMostUntil(config));
  const hostname = Utils.getHostname();

  try {
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName,
      Key: this.buildKey(config.name),
      UpdateExpression: 'SET lockUntil = :lockUntil, lockedAt = :lockedAt, lockedBy = :lockedBy',
      ConditionExpression: 'lockUntil <= :lockedAt OR attribute_not_exists(lockUntil)',
      ExpressionAttributeValues: {
        ':lockUntil': { S: isoLockAtMostUntil },
        ':lockedAt': { S: isoNow },
        ':lockedBy': { S: hostname },
      },
    }));
    return new DynamoDBLock(config, this);
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return undefined;
    throw e;
  }
}
```

Semantics:
- `ConditionExpression` fails when the existing `lockUntil` is greater than `:lockedAt` (lock still valid) → `ConditionalCheckFailedException` → `undefined`.
- `attribute_not_exists(lockUntil)` allows the very first lock attempt on a new item to succeed even though `lockUntil <= :lockedAt` would evaluate to false on a missing attribute (DynamoDB's `<=` returns false when an attribute is absent; the `OR` short-circuits).
- A successful update (condition passes) returns an empty response; the provider wraps the result in a `DynamoDBLock`.

### extend(config)

ShedLock's base DynamoDB provider does not implement extend (it throws). TSLock implements it — the mechanism is a straightforward condition expression:

```typescript
async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const isoNow = Utils.toIsoString(now);
  const isoNewLockAtMostUntil = Utils.toIsoString(lockAtMostUntil(config));
  const hostname = Utils.getHostname();

  try {
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName,
      Key: this.buildKey(config.name),
      UpdateExpression: 'SET lockUntil = :lockUntil',
      ConditionExpression: 'lockedBy = :lockedBy AND lockUntil > :now',
      ExpressionAttributeValues: {
        ':lockUntil': { S: isoNewLockAtMostUntil },
        ':lockedBy': { S: hostname },
        ':now': { S: isoNow },
      },
    }));
    return new DynamoDBLock(config, this);
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return undefined;
    throw e;
  }
}
```

Only the original holder (`lockedBy = hostname`) can extend, and only while the lock is still valid (`lockUntil > now`). Returns `undefined` if the condition fails (lock expired or held by another instance — though "stolen" cannot happen in ShedLock semantics).

### unlock(config)

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const isoUnlock = Utils.toIsoString(unlockTime(config));

  try {
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName,
      Key: this.buildKey(config.name),
      UpdateExpression: 'SET lockUntil = :unlockTime',
      ConditionExpression: `attribute_exists(${this.partitionKey})`,
      ExpressionAttributeValues: {
        ':unlockTime': { S: isoUnlock },
      },
    }));
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return; // item already gone — benign
    throw e;
  }
}
```

- `unlockTime(config)` = `max(now, lockAtLeastUntil(config))` honors `lockAtLeastFor`.
- `attribute_exists(${partitionKey})` guards against creating a stray record when the item does not exist. The `ConditionalCheckFailedException` is swallowed (the lock is already gone — unlock is a no-op).

## File Structure

```
packages/dynamodb/
├── src/
│   ├── index.ts
│   ├── dynamodb-lock-provider.ts                 # DynamoDBLockProvider
│   ├── dynamodb-lock.ts                          # DynamoDBLock extends AbstractSimpleLock
│   ├── dynamodb-accessor.ts                       # DynamoDBAccessor
│   └── dynamodb-lock-provider-options.ts          # options type + validation
├── __tests__/
│   ├── dynamodb-lock-provider.test.ts             # unit tests (mocked client)
│   └── integration/
│       ├── dynamodb-lock-provider.integration.test.ts
│       └── localstack setup (testcontainers)
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `UpdateItem` ConditionExpression fails → `ConditionalCheckFailedException` → `undefined` |
| First lock on a new item | `attribute_not_exists(lockUntil)` succeeds → lock acquired |
| Connection / credentials error | Propagate `DynamoDBServiceException` to the caller |
| Table does not exist | `ResourceNotFoundException` propagates |
| `extend()` on expired lock | `lockUntil > :now` fails → `ConditionalCheckFailedException` → `undefined` |
| `extend()` by a different holder | `lockedBy = :lockedBy` fails → `ConditionalCheckFailedException` → `undefined` |
| `unlock()` on a non-existent item | `attribute_exists(${partitionKey})` fails → `ConditionalCheckFailedException` caught and swallowed (benign no-op) |
| Sort-key mismatch (wrong `sortKey.value`) | `UpdateItem` writes a *new* item under the composite key — this is a configuration error. The provider assumes the `sortKey.value` is constant for all lock names. Document that composite-key tables share a single sort-key value across all locks. |

**ISO-8601 string comparison correctness:** `Utils.toIsoString` emits strings of the form `2018-12-07T12:30:37.810Z` (fixed-width, zero-padded, 3-digit millis, UTC `Z` suffix). Lexicographic comparison of these strings matches chronological comparison. DynamoDB compares string attributes lexicographically via `<`, `<=`, `>`, `>=` operators in `ConditionExpression`. Therefore `lockUntil <= :lockedAt` correctly means "lock expired at time `:lockedAt`".

## Dependencies

- **Peer**: `@tslock/core`, `@aws-sdk/client-dynamodb` (tested against `^3.x`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`, `@testcontainers/localstack`

## Exports

From `src/index.ts`:
- `DynamoDBLockProvider`
- `DynamoDBLockProviderOptions`

`DynamoDBAccessor` and `DynamoDBLock` are not exported as public API.

## Non-Goals (for this package)

- No table creation / provisioning: the table must exist with the configured partition key (and optional sort key). Schema management is the user's responsibility (CDK / Terraform / CloudFormation).
- No TTL attribute support: locks are released via `unlock` / `lockUntil` overwrite. DynamoDB TTL is a feature that could be layered on top to eventually reclaim expired rows, but is not required — the ShedLock algorithm is correct without it. Document TTL as an optional optimization in the README.
- No multi-region / global tables support: the user points the `DynamoDBClient` at whatever region/table they want. The provider is single-region by design.
- No AWS credentials management: the user configures the `DynamoDBClient` with the standard AWS SDK credential chain (env, profile, IAM role, SSO, etc.).
- No `@aws-sdk/util-dynamodb` dependency: native `{ S: ... }` attribute literals are used to keep the peer-dep surface to just `@aws-sdk/client-dynamodb`.
