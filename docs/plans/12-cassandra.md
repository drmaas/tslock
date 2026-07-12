# Implementation Plan: @tslock/cassandra

## Overview

Build the `@tslock/cassandra` provider package. It is a `StorageAccessor` implementation over the `cassandra-driver` Node.js driver, using Lightweight Transactions (LWT) for atomic compare-and-set. Wrapped by `StorageBasedLockProvider` from `@tslock/core`. No core changes required.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built and available
- `cassandra-driver` installed locally for type-checking (v4.6+)
- Docker available locally for the Cassandra testcontainer

## Steps

### Step 1: Initialize package

```
packages/cassandra/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts   (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/cassandra",
  "version": "1.0.0",
  "description": "TSLock provider for Apache Cassandra using Lightweight Transactions",
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
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "cassandra-driver": "^4.6.0"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false },
    "cassandra-driver": { "optional": false }
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0",
    "cassandra-driver": "^4.6.0",
    "testcontainers": "^10.0.0",
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*"
  }
}
```

**`tsup.config.ts`:** identical pattern to core (entry `src/index.ts`, format `['esm','cjs']`, `dts: true`, `clean: true`, `sourcemap: true`).

**`tsconfig.json`:** extends repo root `tsconfig.base.json`. Note: `cassandra-driver` ships its own types, no `@types/cassandra-driver` needed.

### Step 2: Implement validation helpers

**File:** `src/validation.ts`

```typescript
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(value: string, label: string): void {
  if (!value || !IDENTIFIER_RE.test(value)) {
    throw new LockException(`Invalid ${label}: ${value}. Must match ${IDENTIFIER_RE.source}`);
  }
}

export function validateSerialConsistency(level: consistency): void {
  if (level !== consistency.serial && level !== consistency.localSerial) {
    throw new LockException(
      `serialConsistencyLevel must be SERIAL or LOCAL_SERIAL for LWT, got ${level}`
    );
  }
}
```

These run at construction time, not per call, so the cost is paid once.

### Step 3: Define configuration types

**File:** `src/cassandra-lock-provider.ts`

- `CassandraColumnNames` interface (4 readonly string fields, snake_case defaults).
- `CassandraLockProviderOptions` interface (`keyspace` required; `tableName`, `columnNames`, `lockedByValue`, `consistencyLevel`, `serialConsistencyLevel` optional).
- `DEFAULT_TABLE_NAME = 'shedlock'`.
- `DEFAULT_COLUMN_NAMES` constant object.
- `resolveOptions(options)`:
  - Merge with defaults.
  - `validateIdentifier(keyspace, 'keyspace')`.
  - `validateIdentifier(tableName, 'tableName')`.
  - For each column name: `validateIdentifier(name, 'columnNames.<field>')`.
  - `validateSerialConsistency(serialConsistencyLevel)`.
  - Return fully-populated `ResolvedOptions`.

Import `consistency` from `cassandra-driver`:
```typescript
import { consistency } from 'cassandra-driver';
```
The `consistency` enum exposes `localQuorum`, `localSerial`, `serial`, etc.

### Step 4: Implement CQL statement builders

**File:** `src/cassandra-cql.ts`

Pure functions returning CQL strings given resolved options. Like the Neo4j package, identifiers (keyspace, table, column names) are interpolated directly into the CQL after validation; values are `?` positional placeholders.

```typescript
function buildInsertCql(opts: ResolvedOptions): string;
function buildUpdateCql(opts: ResolvedOptions): string;
function buildUnlockCql(opts: ResolvedOptions): string;
function buildExtendCql(opts: ResolvedOptions): string;
function buildCreateTableCql(opts: ResolvedOptions): string;
```

Example output for default options:
```cql
// insert
INSERT INTO shedlock.shedlock (name, lock_until, locked_at, locked_by) VALUES (?, ?, ?, ?) IF NOT EXISTS

// update
UPDATE shedlock.shedlock SET lock_until = ?, locked_at = ?, locked_by = ? WHERE name = ? IF lock_until < ?

// unlock
UPDATE shedlock.shedlock SET lock_until = ? WHERE name = ? IF locked_by = ? AND lock_until >= ?

// extend
UPDATE shedlock.shedlock SET lock_until = ? WHERE name = ? IF locked_by = ? AND lock_until >= ?

// createTable
CREATE TABLE IF NOT EXISTS shedlock.shedlock (name text PRIMARY KEY, lock_until timestamp, locked_at timestamp, locked_by text)
```

Note the `<keyspace>.<table>` qualification — required because the client may be connected without a default keyspace, or to make the queries self-contained for logging.

### Step 5: Implement CassandraStorageAccessor

**File:** `src/cassandra-storage-accessor.ts`

```typescript
import { consistency } from 'cassandra-driver';
import {
  AbstractStorageAccessor,
  ClockProvider,
  LockConfiguration,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';

class CassandraStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly client: Client,
    private readonly opts: ResolvedOptions,
  ) {}

  async insertRecord(config: LockConfiguration): Promise<boolean>;
  async updateRecord(config: LockConfiguration): Promise<boolean>;
  async unlock(config: LockConfiguration): Promise<void>;
  async extend(config: LockConfiguration): Promise<boolean>;
}
```

Each method uses a shared helper to execute a query and inspect `[applied]`:

```typescript
private async executeLwt(
  cql: string,
  params: (string | Date)[],
): Promise<boolean> {
  const result = await this.client.execute(cql, params, {
    consistency: this.opts.consistencyLevel,
    serialConsistency: this.opts.serialConsistencyLevel,
  });
  return result.rows[0]?.['[applied]'] === true;
}

private asDate(epochMillis: number): Date {
  return new Date(epochMillis);
}
```

#### insertRecord

```typescript
const cql = buildInsertCql(this.opts);
const params = [
  config.name,
  this.asDate(lockAtMostUntil(config)),
  this.asDate(ClockProvider.now()),
  this.opts.lockedByValue,
];
return this.executeLwt(cql, params);
```

#### updateRecord

```typescript
const cql = buildUpdateCql(this.opts);
const now = this.asDate(ClockProvider.now());
const params = [
  this.asDate(lockAtMostUntil(config)),
  this.asDate(ClockProvider.now()),
  this.opts.lockedByValue,
  config.name,
  now,
];
return this.executeLwt(cql, params);
```

#### unlock

```typescript
const cql = buildUnlockCql(this.opts);
const params = [
  this.asDate(unlockTime(config)),
  config.name,
  this.opts.lockedByValue,
  this.asDate(ClockProvider.now()),
];
await this.executeLwt(cql, params);
// best-effort: swallow [applied] = false
```

#### extend

```typescript
const cql = buildExtendCql(this.opts);
const params = [
  this.asDate(lockAtMostUntil(config)),
  config.name,
  this.opts.lockedByValue,
  this.asDate(ClockProvider.now()),
];
return this.executeLwt(cql, params);
```

### Step 6: Implement createLockTable helper

**File:** `src/schema.ts`

```typescript
export async function createLockTable(
  client: Client,
  options: { keyspace: string; tableName?: string; columnNames?: CassandraColumnNames },
): Promise<void> {
  const opts = resolveOptionsForSchema(options);  // subset of resolveOptions, no consistency
  const cql = buildCreateTableCql(opts);
  await client.execute(cql);
}
```

- Uses `CREATE TABLE IF NOT EXISTS` — idempotent.
- Does not set LWT consistency options (this is a DDL statement, not LWT).

### Step 7: Implement CassandraLockProvider

**File:** `src/cassandra-lock-provider.ts` (extended)

```typescript
class CassandraLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(client: Client, options: CassandraLockProviderOptions) {
    this.delegate = new StorageBasedLockProvider(
      new CassandraStorageAccessor(client, resolveOptions(options)),
    );
  }

  lock(config) { return this.delegate.lock(config); }
  clearCache(name) { this.delegate.clearCache(name); }
}
```

Construction throws if `resolveOptions` validation fails.

### Step 8: Wire up index.ts

Export:
- `CassandraLockProvider`
- `CassandraLockProviderOptions`, `CassandraColumnNames`
- `createLockTable`

Do **not** export `CassandraStorageAccessor`, `ResolvedOptions`, or the CQL builders.

### Step 9: Write unit tests

**File:** `__tests__/unit/validation.test.ts`
- `validateIdentifier` accepts `shedlock`, `my_table`, `_foo`.
- `validateIdentifier` rejects `'invalid-name'`, `''`, `'1bad'`, `'with space'`.
- `validateSerialConsistency` accepts `consistency.serial`, `consistency.localSerial`.
- `validateSerialConsistency` rejects `consistency.localQuorum`, `consistency.one`.

**File:** `__tests__/unit/cassandra-cql.test.ts**
- `buildInsertCql` with default options → expected string.
- `buildUpdateCql` with custom keyspace + table → expected string with correct qualification.
- `buildUnlockCql` and `buildExtendCql` produce identical CQL (same shape, intent differs at call site).
- `buildCreateTableCql` with custom column names → expected string.

**File:** `__tests__/unit/cassandra-storage-accessor.test.ts`

Use a mocked `Client` (`vi.fn()` for `execute`). The mock returns a fake `ResultSet` with `rows: [{ '[applied]': true }]` or `rows: [{ '[applied]': false }]`, or throws a configured error.

- `insertRecord` `[applied] = true` → `client.execute` called with insert CQL + 4 params (name, Date, Date, hostname), returns `true`.
- `insertRecord` `[applied] = false` → returns `false`.
- `insertRecord` throws → propagates.
- `updateRecord` `[applied] = true` → returns `true`; verify 5 positional params in correct order (new lock_until, new locked_at, locked_by, name, now).
- `updateRecord` `[applied] = false` → returns `false`.
- `unlock` `[applied] = true` → resolves; verify params (unlockTime, name, locked_by, now).
- `unlock` `[applied] = false` → resolves (swallowed, no error).
- `extend` `[applied] = true` → returns `true`.
- `extend` `[applied] = false` → returns `false`.
- `execute` called with `consistency` and `serialConsistency` options matching the configured levels.
- Date parameters are `Date` instances (not raw numbers).
- CQL string contains the qualified `<keyspace>.<table>` name.
- Custom `columnNames` appear in the CQL.

**File:** `__tests__/unit/schema.test.ts`
- `createLockTable` calls `client.execute` with `CREATE TABLE IF NOT EXISTS <keyspace>.<table> ...`.
- Statement uses custom column names when provided.
- Throws if `client.execute` throws.

### Step 10: Write integration tests

**File:** `__tests__/integration/cassandra-integration.test.ts`

```typescript
import { storageBasedLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { CassandraLockProvider, createLockTable } from '../src/index.js';
import cassandra from 'cassandra-driver';

describe('CassandraLockProvider integration', () => {
  let container: StartedTestContainer;
  let lockClient: cassandra.Client;

  beforeAll(async () => {
    container = await new GenericContainer('cassandra:4.1')
      .withExposedPorts(9042)
      .withEnvironment({
        CASSANDRA_LISTEN_ADDRESS: 'auto',
        CASSANDRA_BROADCAST_ADDRESS: 'localhost',
      })
      .withStartupTimeout(180_000)
      .start();

    const adminClient = new cassandra.Client({
      contactPoints: [`${container.getHost()}:${container.getMappedPort(9042)}`],
      localDataCenter: 'datacenter1',
    });
    await waitForCassandra(adminClient);  // poll DESCRIBE KEYSPACES until it succeeds
    await adminClient.execute(
      "CREATE KEYSPACE IF NOT EXISTS shedlock_test " +
      "WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}"
    );
    await createLockTable(adminClient, { keyspace: 'shedlock_test' });
    await adminClient.shutdown();

    lockClient = new cassandra.Client({
      contactPoints: [`${container.getHost()}:${container.getMappedPort(9042)}`],
      localDataCenter: 'datacenter1',
      keyspace: 'shedlock_test',
    });
    await lockClient.connect();
  });

  afterAll(async () => {
    if (lockClient) await lockClient.shutdown();
    if (container) await container.stop();
  });

  storageBasedLockProviderIntegrationTests(
    async () => new CassandraLockProvider(lockClient, { keyspace: 'shedlock_test' }),
    { timeMode: 'real' },
  );

  fuzzTests(async () => new CassandraLockProvider(lockClient, { keyspace: 'shedlock_test' }));

  describe('provider-specific', () => {
    it('LWT insert returns [applied] = false on duplicate', async () => {
      const provider = new CassandraLockProvider(lockClient, { keyspace: 'shedlock_test' });
      const lock = await provider.lock(config('lwt-dup', '1m'));
      expect(lock).toBeDefined();
      const result = await lockClient.execute(
        "INSERT INTO shedlock_test.shedlock (name, lock_until, locked_at, locked_by) " +
        "VALUES (?, ?, ?, ?) IF NOT EXISTS",
        ['lwt-dup', new Date(), new Date(), 'other'],
        { consistency: cassandra.types.consistencies.localQuorum,
          serialConsistency: cassandra.types.consistencies.localSerial },
      );
      expect(result.rows[0]['[applied]']).toBe(false);
      await lock!.unlock();
    });

    it('rejects extend from a different lockedBy', async () => {
      const owner = new CassandraLockProvider(lockClient, {
        keyspace: 'shedlock_test', lockedByValue: 'node-A',
      });
      const intruder = new CassandraLockProvider(lockClient, {
        keyspace: 'shedlock_test', lockedByValue: 'node-B',
      });
      const lock = await owner.lock(config('extend-foreign', '1m'));
      const extended = await lock!.extend('1m', 0);
      expect(extended).toBeDefined();
      await extended!.unlock();
    });
  });
});

async function waitForCassandra(client: cassandra.Client): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await client.execute('DESCRIBE KEYSPACES');
      return;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Cassandra did not become ready within 120s');
}
```

**Container startup:** Cassandra 4.x takes 30-60s to bootstrap. Use `withStartupTimeout(180_000)` and the polling helper above — the `testcontainers` `Wait.forLogMessage('Starting listening for CQL clients')` strategy also works but polling `DESCRIBE KEYSPACES` is more reliable because it confirms the CQL native protocol is ready, not just that the log message appeared.

**Real-time waits:** Use `timeMode: 'real'`. LWT operations use the client's clock (`ClockProvider.now()`) for `lock_until` comparisons, so the test process's clock and the Cassandra server's clock must be approximately synchronized. The testcontainer shares the host's clock, so this is guaranteed.

**Single-node LWT caveat:** The testcontainer is a single-node cluster with `replication_factor = 1`. Paxos still runs but quorum is trivial. The integration test verifies correctness of the CQL and `[applied]` handling, not multi-node contention. Document this in the test file header.

### Step 11: Verify

```bash
cd packages/cassandra
pnpm typecheck
pnpm test               # unit only
pnpm test:integration   # requires Docker
pnpm build
```

All must pass. Integration tests are gated behind a separate Vitest config.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Cassandra container slow / flaky startup** | Generous `withStartupTimeout(180_000)` + polling `DESCRIBE KEYSPACES` rather than waiting on a log line. Mark suite `test.slow`. |
| **`cassandra-driver` v4 type resolution** | `cassandra-driver` ships its own types — no `@types/*` needed. Verify `consistency` enum import works in ESM (`import { consistency } from 'cassandra-driver'`). |
| **LWT performance under contention** | Document: LWT uses Paxos, which is 2-4x slower than regular writes. For scheduled-task locks (low contention, infrequent), this is fine. For high-frequency locking, consider a different provider. |
| **`[applied]` column name** | Cassandra returns `[applied]` as the first column of every LWT result row. The driver exposes it as `result.rows[0]['[applied]']`. Test this explicitly against a real Cassandra instance to confirm the driver does not rename the column. |
| **Time representation** | Use `new Date(epochMillis)` for `timestamp` columns. The driver round-trips `Date` ↔ `timestamp` faithfully. Test that a round-tripped timestamp equals the original epoch millis. |
| **Timezone drift between client and server** | Cassandra `timestamp` is always stored as UTC milliseconds. `new Date(epochMillis)` is UTC-based. No timezone issues. |
| **Identifier injection** | Validate keyspace, table, and column names against `^[a-zA-Z_][a-zA-Z0-9_]*$` at construction time. CQL has no parameterization for identifiers — they must be interpolated. |
| **`serialConsistencyLevel` misconfiguration** | `validateSerialConsistency` throws at construction if a non-serial level is supplied. Prevents silent incorrectness. |
| **`consistencyLevel` too low for LWT** | Default `LOCAL_QUORUM` is correct for the non-serial portion. Document that lowering it (e.g., to `ONE`) weakens the LWT guarantee. |
| **Multi-DC clusters** | Document: `LOCAL_SERIAL` (default) is correct for single-DC. For cross-DC consistency, set `serialConsistencyLevel: consistency.serial`. |
| **Paxos contention throws** | `OperationTimedOutError` / `WriteFailureError` propagate. The caller decides whether to retry. Document this in the spec. |
| **`lockedBy` mismatch on extend after restart** | Document: users should set `lockedByValue` explicitly if hostname could change between lock acquisition and extension. |

## Estimation

~7 source files, ~450-550 lines of implementation + ~350-450 lines of tests. The LWT semantics are the main complexity; the testcontainer setup is the main operational risk. One focused session plus debugging time for the Cassandra container.

## Order of Implementation

1. Package scaffold.
2. `validation.ts` + unit tests (no driver dependency for identifier validation; import `consistency` enum for serial-consistency check).
3. `cassandra-cql.ts` + unit tests (no driver dependency).
4. `cassandra-lock-provider.ts` types + `resolveOptions`.
5. `cassandra-storage-accessor.ts` (mocked driver unit tests).
6. `schema.ts` + unit tests.
7. `index.ts` exports.
8. Integration tests with testcontainer (allow extra time for container startup + polling).
9. Verify (typecheck, unit, integration, build).
