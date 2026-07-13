# Implementation Plan: @tslock/dynamodb

## Overview

Build the `@tslock/dynamodb` package — a DIRECT LockProvider using AWS SDK v3 `UpdateItem` + `ConditionExpression`. Tests run against LocalStack (via testcontainers) for parity with real DynamoDB without AWS account costs. The package depends on `@tslock/core` and `@aws-sdk/client-dynamodb` as peer deps.

## Prerequisites

- `@tslock/core` and `@tslock/test-support` built and available in the workspace
- `@aws-sdk/client-dynamodb` installed as a dev dep for type-checks and tests
- `testcontainers` + `@testcontainers/localstack` available for integration tests
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/dynamodb/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/dynamodb",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*", "@aws-sdk/client-dynamodb": "^3.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "@aws-sdk/client-dynamodb": "^3.0.0",
    "@testcontainers/localstack": "^10.0.0",
    "testcontainers": "^10.0.0",
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

**`tsup.config.ts`:**
```typescript
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

### Step 2: Define DynamoDBLockProviderOptions + validation

**File:** `src/dynamodb-lock-provider-options.ts`

- Interface with `client?`, `tableName`, `partitionKey?`, `sortKey?`.
- Validate in a `validateOptions(opts)` function called from the provider constructor:
  - `tableName` non-empty string (else throw `LockException`).
  - `partitionKey` defaults to `'_id'` if omitted.
  - `sortKey`, if present, must have non-empty `name` AND `value`.
- Return normalized options (defaults filled in).

### Step 3: Implement DynamoDBAccessor

**File:** `src/dynamodb-accessor.ts`

- Imports from `@aws-sdk/client-dynamodb`: `DynamoDBClient`, `UpdateItemCommand`, `ConditionalCheckFailedException`.
- Constructor: `(client, tableName, partitionKey, sortKey?)`.
- `private buildKey(name)`: returns `{ [partitionKey]: { S: name } }` or with sortKey added.
- `lock(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname();`
  2. Build ISO strings: `isoNow = Utils.toIsoString(now)`, `isoLockAtMostUntil = Utils.toIsoString(lockAtMostUntil(config))`.
  3. `try { await client.send(new UpdateItemCommand({ TableName, Key: buildKey(config.name), UpdateExpression: 'SET lockUntil = :lockUntil, lockedAt = :lockedAt, lockedBy = :lockedBy', ConditionExpression: 'lockUntil <= :lockedAt OR attribute_not_exists(lockUntil)', ExpressionAttributeValues: { ':lockUntil': { S: isoLockAtMostUntil }, ':lockedAt': { S: isoNow }, ':lockedBy': { S: hostname } } }));`
  4. Return `new DynamoDBLock(config, this)`.
  5. `catch (e)`: if `e instanceof ConditionalCheckFailedException` → return `undefined`; else rethrow.
- `extend(config)`:
  1. Same pattern; `UpdateExpression: 'SET lockUntil = :lockUntil'`, `ConditionExpression: 'lockedBy = :lockedBy AND lockUntil > :now'`.
  2. `ExpressionAttributeValues`: `:lockUntil`, `:lockedBy`, `:now` (all `{ S: ... }`).
  3. Same `ConditionalCheckFailedException` handling.
- `unlock(config)`:
  1. `isoUnlock = Utils.toIsoString(unlockTime(config))`.
  2. `try { await client.send(new UpdateItemCommand({ TableName, Key: buildKey(config.name), UpdateExpression: 'SET lockUntil = :unlockTime', ConditionExpression: `attribute_exists(${partitionKey})`, ExpressionAttributeValues: { ':unlockTime': { S: isoUnlock } } })); }`
  3. `catch (e)`: if `ConditionalCheckFailedException` → return (swallow); else rethrow.

### Step 4: Implement DynamoDBLock

**File:** `src/dynamodb-lock.ts`

- `class DynamoDBLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: DynamoDBAccessor, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock()` → `await this.accessor.unlock(this.config)`
  - `protected async doExtend(newConfig)` → `return await this.accessor.extend(newConfig)`

### Step 5: Implement DynamoDBLockProvider

**File:** `src/dynamodb-lock-provider.ts`

- `import { DynamoDBClient } from '@aws-sdk/client-dynamodb'`
- `class DynamoDBLockProvider implements ExtensibleLockProvider`:
  - `private readonly accessor: DynamoDBAccessor`
  - `constructor(options: DynamoDBLockProviderOptions)`:
    1. `const opts = validateOptions(options)`
    2. `const client = opts.client ?? new DynamoDBClient()` (default client uses standard credential chain — for tests, the user passes a configured client pointing at LocalStack)
    3. `this.accessor = new DynamoDBAccessor(client, opts.tableName, opts.partitionKey, opts.sortKey)`
  - `async lock(config)` → `return await this.accessor.lock(config)`

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `DynamoDBLockProvider`
- `DynamoDBLockProviderOptions`

Do NOT export `DynamoDBAccessor` or `DynamoDBLock`.

### Step 7: Write unit tests (mocked client)

**File:** `__tests__/dynamodb-lock-provider.test.ts`

Mock the `DynamoDBClient`: `const send = vi.fn(); const client = { send } as unknown as DynamoDBClient;`. Use `new DynamoDBLockProvider({ client, tableName: 'shedlock-test' })`.

- `lock()`:
  - `send` resolves → `DynamoDBLock` returned. Assert `UpdateItemCommand` constructor args: `TableName`, `Key`, `UpdateExpression`, `ConditionExpression`, `ExpressionAttributeValues` with `{ S: ... }` literals.
  - `send` rejects with `new ConditionalCheckFailedException(...)` → `undefined`.
  - `send` rejects with `new ResourceNotFoundException(...)` → propagates.
- `extend()`:
  - `send` resolves → `DynamoDBLock` returned.
  - `send` rejects with `ConditionalCheckFailedException` → `undefined`.
  - Assert `ConditionExpression` is `'lockedBy = :lockedBy AND lockUntil > :now'`.
- `unlock()`:
  - Assert `UpdateExpression: 'SET lockUntil = :unlockTime'`.
  - Assert `ConditionExpression: 'attribute_exists(_id)'` (default partition key).
  - With `lockAtLeastFor=5s`, assert `:unlockTime` value is `Utils.toIsoString(unlockTime(config))` where `unlockTime >= now + 5s`.
  - `send` rejects with `ConditionalCheckFailedException` → swallowed (no throw).
- Verify ISO strings: `Utils.toIsoString(now)` produces `2018-12-07T12:30:37.810Z`-shaped strings (3-digit millis).
- Sort-key path: construct provider with `sortKey: { name: 'env', value: 'prod' }`. Assert `Key` includes both `partitionKey` and `sortKey.name`.

### Step 8: Write integration tests (LocalStack via testcontainers)

**File:** `__tests__/integration/dynamodb-lock-provider.integration.test.ts`

- Start LocalStack:
  ```typescript
  import { LocalstackContainer } from '@testcontainers/localstack';
  const container = await new LocalstackContainer('localstack/localstack:3.0.0').start();
  const client = new DynamoDBClient({
    endpoint: container.getConnectionUri(),
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  ```
- `beforeAll`:
  1. Start container.
  2. Create client pointing at LocalStack endpoint.
  3. `await client.send(new CreateTableCommand({ TableName: 'shedlock-test', KeySchema: [{ AttributeName: '_id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: '_id', AttributeType: 'S' }], BillingMode: 'PAY_PER_REQUEST' }))`.
  4. `provider = new DynamoDBLockProvider({ client, tableName: 'shedlock-test' })`.
- `afterAll`: `DeleteTableCommand`, stop container.
- `beforeEach`: delete all items (or use a unique partition key per test via `uniqueLockName`). Reset `ClockProvider`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })` and `extensibleLockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.

**Sort-key integration suite:** Add a second describe block:
- Create table with composite key: `KeySchema: [{ AttributeName: '_id', KeyType: 'HASH' }, { AttributeName: 'env', KeyType: 'RANGE' }]`, `AttributeDefinitions: [{ AttributeName: '_id', AttributeType: 'S' }, { AttributeName: 'env', AttributeType: 'S' }]`.
- `provider = new DynamoDBLockProvider({ client, tableName: 'shedlock-composite-test', sortKey: { name: 'env', value: 'prod' } })`.
- Run the same integration test contracts.

### Step 9: Verify

```bash
cd packages/dynamodb
pnpm typecheck
pnpm test
pnpm test:integration   # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LocalStack DynamoDB behavior differs from real DynamoDB on `ConditionExpression` edge cases | LocalStack's DynamoDB implementation is mature for the operations we use (`UpdateItem` + conditions). Add a CI job (optional) that runs integration tests against real DynamoDB in a test account. |
| `ConditionalCheckFailedException` import path changes across SDK v3 versions | Import from `@aws-sdk/client-dynamodb` (top-level, stable). Pin `^3.0.0` in `peerDependencies`. Add a unit test that constructs the error class to catch import regressions. |
| ISO string comparison correctness in DynamoDB | ISO-8601 with 3-digit millis (`Utils.toIsoString`) sorts lexicographically == chronologically. Add a unit test asserting string comparison matches numeric comparison for a range of timestamps across second/minute/hour boundaries. |
| `marshall` vs manual `{ S: ... }` literals | Use manual `{ S: ... }` literals — keeps the dep surface to `@aws-sdk/client-dynamodb` only (no `@aws-sdk/util-dynamodb` peer dep). |
| Unlock on a non-existent item creates a stray record | Add `ConditionExpression: 'attribute_exists(${partitionKey})'` to unlock; swallow `ConditionalCheckFailedException`. Unit test verifies no item is created when unlock is called on a missing key. |
| Sort-key support: easy to forget in `Key` construction for one operation | Single `buildKey(name)` helper used by all three operations (lock/extend/unlock). Integration test suite #2 exercises the composite-key path. |
| Eventual consistency of DynamoDB reads | The provider does not read — it only writes with conditions. `UpdateItem` is strongly consistent for the condition check. No concern. |
| Default `DynamoDBClient()` construction without credentials fails in non-AWS environments | Tests always pass an explicit `client`. Document that production users should pass a configured `client`. If `client` is omitted, the SDK throws a clear credential error. |
| `attribute_not_exists(lockUntil)` semantics: missing attribute returns false for `<=`, true for `attribute_not_exists` | Verified against DynamoDB docs. The `OR` short-circuit handles this. Unit test: first lock on a non-existent item succeeds. |

## Estimation

~5 source files, ~300-400 lines of implementation + ~400-500 lines of tests (two integration suites — partition-key and composite-key). Half a session with Docker + LocalStack.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `DynamoDBLockProviderOptions` type + `validateOptions`
3. `DynamoDBAccessor` (lock, extend, unlock — all the SDK calls + `buildKey` helper)
4. `DynamoDBLock` (thin `AbstractSimpleLock` subclass)
5. `DynamoDBLockProvider`
6. `index.ts`
7. Unit tests (mocked `DynamoDBClient`)
8. Integration tests — partition-key-only table
9. Integration tests — composite-key table (sort key)
