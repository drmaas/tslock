# Spec: @tslock/cassandra

## Overview

The `@tslock/cassandra` package provides a distributed lock provider backed by [Apache Cassandra](https://cassandra.apache.org/). It uses the `StorageBasedLockProvider` pattern from `@tslock/core` with a `StorageAccessor` implementation that issues CQL (Cassandra Query Language) statements using **Lightweight Transactions (LWT)** — Cassandra's compare-and-set primitive based on Paxos consensus.

Lock uniqueness and atomic state transitions are enforced by:
- `INSERT ... IF NOT EXISTS` for `insertRecord` — atomically fails if the row already exists.
- `UPDATE ... IF <condition>` for `updateRecord`, `unlock`, and `extend` — atomically checks a precondition before applying the update.

LWT carries a consistency requirement: the operation must use `SERIAL` or `LOCAL_SERIAL` as the serial consistency level. The provider configures this by default.

This is a direct port of ShedLock's `CassandraLockProvider`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/cassandra` |
| **Dependencies** | `@tslock/core` (peer), `cassandra-driver` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. CassandraLockProvider

```typescript
import type { Client } from 'cassandra-driver';
import { StorageBasedLockProvider, ExtensibleLockProvider } from '@tslock/core';

class CassandraLockProvider implements ExtensibleLockProvider {
  constructor(client: Client, options: CassandraLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  clearCache(name: string): void;
}
```

**Constructor:**
- `client` — a `cassandra-driver` `Client` instance. The caller is responsible for client lifecycle (`client.connect()`, `client.shutdown()`).
- `options` — **required** (because `keyspace` is required). See below.

**Behavior:** Delegates to `new StorageBasedLockProvider(new CassandraStorageAccessor(client, options))`. Implements `ExtensibleLockProvider` because `extend()` is supported.

### 2. CassandraLockProviderOptions

```typescript
interface CassandraLockProviderOptions {
  readonly keyspace: string;                          // required
  readonly tableName?: string;                        // default: 'shedlock'
  readonly columnNames?: CassandraColumnNames;       // default: see below
  readonly lockedByValue?: string;                    // default: Utils.getHostname()
  readonly consistencyLevel?: consistency;            // default: LOCAL_QUORUM
  readonly serialConsistencyLevel?: consistency;     // default: LOCAL_SERIAL
}

interface CassandraColumnNames {
  readonly name: string;        // default: 'name'
  readonly lockUntil: string;  // default: 'lock_until'
  readonly lockedAt: string;    // default: 'locked_at'
  readonly lockedBy: string;    // default: 'locked_by'
}
```

- **`keyspace`** (required) — the Cassandra keyspace containing the lock table. The keyspace must exist before the provider is used; the provider does not create it.
- **`tableName`** — table name within the keyspace. The table must exist (see Setup).
- **`columnNames`** — column names in the lock table. Must match the table schema.
- **`lockedByValue`** — value written to the `locked_by` column. Defaults to the current hostname.
- **`consistencyLevel`** — Cassandra consistency level for non-LWT reads/writes. Default `LOCAL_QUORUM`. Must be compatible with the serial consistency (e.g., `LOCAL_QUORUM` + `LOCAL_SERIAL` for a single-DC cluster).
- **`serialConsistencyLevel`** — Cassandra serial consistency level for LWT operations. Default `LOCAL_SERIAL`. Must be `SERIAL` or `LOCAL_SERIAL` (LWT requirement).

The `consistency` type is re-exported from `cassandra-driver` (`import { types } from 'cassandra-driver'; type consistency = types.consistencies`).

### 3. Exported Helpers

```typescript
export function createLockTable(
  client: Client,
  options: { keyspace: string; tableName?: string; columnNames?: CassandraColumnNames },
): Promise<void>;
```

Executes the `CREATE TABLE IF NOT EXISTS` statement with the configured table and column names. Provided as a convenience for application startup; idempotent.

## Locking Mechanism

All operations use `client.execute(cql, params, { consistency, serialConsistency })`. LWT operations (`IF NOT EXISTS`, `IF <condition>`) return a result row whose first column is `[applied]` (boolean) — `true` if the transaction succeeded, `false` if the precondition failed.

### insertRecord(config)

Executed when the lock name has not been seen before by the in-memory `LockRecordRegistry`. Inserts a new row only if no row with the same primary key exists.

```cql
INSERT INTO <keyspace>.<table> (<name_col>, <lock_until_col>, <locked_at_col>, <locked_by_col>)
VALUES (?, ?, ?, ?)
IF NOT EXISTS
```

**Parameters (positional):**
- `config.name`
- `lockAtMostUntil(config)` (epoch millis as a `Date` — `cassandra-driver` maps `Date` to Cassandra `timestamp`)
- `ClockProvider.now()` (epoch millis as `Date`)
- `options.lockedByValue ?? Utils.getHostname()`

**Result handling:**
- `result.rows[0]['[applied]'] === true` → return `true` (lock acquired).
- `result.rows[0]['[applied]'] === false` → return `false` (lock already exists).
- Errors → propagate.

### updateRecord(config)

Executed when `insertRecord` failed or when the lock name is already in the registry. Updates the existing row only if its `lock_until` is in the past (the lock has expired).

```cql
UPDATE <keyspace>.<table>
SET <lock_until_col> = ?, <locked_at_col> = ?, <locked_by_col> = ?
WHERE <name_col> = ?
IF <lock_until_col> < ?
```

**Parameters (positional):**
- `lockAtMostUntil(config)` (new expiry)
- `ClockProvider.now()` (new `locked_at`)
- `options.lockedByValue ?? Utils.getHostname()`
- `config.name` (WHERE clause)
- `ClockProvider.now()` (IF condition: current time to compare against stored `lock_until`)

**Result handling:**
- `result.rows[0]['[applied]'] === true` → return `true` (lock was expired, we took it).
- `result.rows[0]['[applied]'] === false` → return `false` (lock still valid, held by someone else).
- Errors → propagate.

### unlock(config)

Sets `lock_until` to `unlockTime(config)` — the later of "now" and `lockAtLeastUntil(config)`. This implements `lockAtLeastFor`. The update is conditional: only applied if the current instance still owns the lock and the lock is still valid.

```cql
UPDATE <keyspace>.<table>
SET <lock_until_col> = ?
WHERE <name_col> = ?
IF <locked_by_col> = ? AND <lock_until_col> >= ?
```

**Parameters (positional):**
- `unlockTime(config)` (new `lock_until`)
- `config.name` (WHERE clause)
- `options.lockedByValue ?? Utils.getHostname()` (IF: must still own the lock)
- `ClockProvider.now()` (IF: lock must still be valid — `lock_until >= now`)

**Result handling:**
- `[applied] === true` → unlock succeeded, return `void`.
- `[applied] === false` → the lock is no longer owned or no longer valid. This is acceptable during normal unlock (the lock may have expired or been taken by another instance after expiry). Swallow and return `void` (best-effort; a stale lock would have expired via `lockAtMostFor`).
- Errors → propagate.

### extend(config)

Extends the lock only if the current instance still owns it and the lock is still valid.

```cql
UPDATE <keyspace>.<table>
SET <lock_until_col> = ?
WHERE <name_col> = ?
IF <locked_by_col> = ? AND <lock_until_col> >= ?
```

**Parameters (positional):**
- `lockAtMostUntil(config)` (new expiry)
- `config.name` (WHERE clause)
- `options.lockedByValue ?? Utils.getHostname()` (IF: must still own)
- `ClockProvider.now()` (IF: lock must still be valid)

**Result handling:**
- `[applied] === true` → return `true` (lock extended).
- `[applied] === false` → return `false` (lock expired or stolen).
- Errors → propagate.

**Note:** `unlock` and `extend` use the same CQL shape (different `SET` value and different intent). The provider keeps them as separate methods for clarity and because `unlock` is best-effort while `extend` returns a boolean.

## Configuration

### Default values

| Option | Default |
|---|---|
| `tableName` | `'shedlock'` |
| `columnNames.name` | `'name'` |
| `columnNames.lockUntil` | `'lock_until'` |
| `columnNames.lockedAt` | `'locked_at'` |
| `columnNames.lockedBy` | `'locked_by'` |
| `lockedByValue` | `Utils.getHostname()` |
| `consistencyLevel` | `LOCAL_QUORUM` |
| `serialConsistencyLevel` | `LOCAL_SERIAL` |

### Validation

- `keyspace` must be a non-empty string matching `^[a-zA-Z_][a-zA-Z0-9_]*$` (Cassandra identifier).
- `tableName` must match the same identifier pattern.
- All column names must match the same pattern.
- `consistencyLevel` and `serialConsistencyLevel` must be valid `types.consistencies` values. `serialConsistencyLevel` must be `SERIAL` or `LOCAL_SERIAL` — the provider throws `LockException` if any other value is supplied (LWT requires serial consistency).

## Setup Requirements

The user (or the exported `createLockTable()` helper) must create the lock table before the first lock attempt. The table must use the configured column names.

### Default schema

```cql
CREATE TABLE IF NOT EXISTS <keyspace>.shedlock (
  name        text PRIMARY KEY,
  lock_until  timestamp,
  locked_at   timestamp,
  locked_by   text
);
```

### Custom column names

If non-default `columnNames` are configured, the `CREATE TABLE` statement must use the same names. The `createLockTable()` helper builds the statement from the resolved options.

### Custom table name

If `tableName` is non-default, substitute it in the statement.

### Keyspace

The keyspace must exist before the table can be created. Typical production setup:

```cql
CREATE KEYSPACE IF NOT EXISTS shedlock
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 3};
```

The user is responsible for choosing an appropriate replication strategy and factor for their cluster topology.

### Consistency

LWT operations require `SERIAL` or `LOCAL_SERIAL` as the serial consistency level. The default `LOCAL_SERIAL` works for single-DC clusters. For multi-DC clusters where locks must be globally consistent, use `SERIAL` (slower but cross-DC consistent).

The non-serial `consistencyLevel` (default `LOCAL_QUORUM`) applies to the non-LWT portion of the operation (e.g., reading the result row). `LOCAL_QUORUM` is the standard choice for single-DC clusters.

### No additional schema

- No secondary indexes are needed — all queries use the primary key (`name`).
- No materialized views, no SASI indexes.
- LWT uses Paxos internally; no extra schema objects.

## File Structure

```
packages/cassandra/
├── src/
│   ├── index.ts                       # public exports
│   ├── cassandra-lock-provider.ts      # CassandraLockProvider, CassandraLockProviderOptions
│   ├── cassandra-storage-accessor.ts   # CassandraStorageAccessor extends AbstractStorageAccessor
│   ├── cassandra-cql.ts                # CQL statement builders (parameterized)
│   ├── schema.ts                      # createLockTable helper
│   └── validation.ts                  # identifier validation + consistency level checks
├── __tests__/
│   ├── unit/
│   │   ├── cassandra-storage-accessor.test.ts   # mocked Client
│   │   ├── cassandra-cql.test.ts               # statement building
│   │   ├── schema.test.ts                       # mocked createLockTable
│   │   └── validation.test.ts
│   └── integration/
│       ├── cassandra-integration.test.ts        # extends storageBasedLockProviderIntegrationTests
│       └── docker-compose.yml                   # Cassandra testcontainer config
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling

| Situation | Detection | Behavior |
|---|---|---|
| Lock held on insert | `result.rows[0]['[applied]'] === false` | `insertRecord` returns `false` |
| Lock held on update (still valid) | `result.rows[0]['[applied]'] === false` | `updateRecord` returns `false` |
| Lock expired or stolen on extend | `result.rows[0]['[applied]'] === false` | `extend` returns `false` |
| Unlock precondition fails | `result.rows[0]['[applied]'] === false` | Swallow, return `void` (best-effort) |
| Connection / network error | `cassandra-driver` errors (`NoHostAvailableError`, etc.) | Propagate |
| Timeout error | `driverError.isTimeout === true` | Propagate |
| Keyspace / table not found | `InvalidQueryError` with message containing `unconfigured table` or `keyspace` | Propagate (indicates misconfiguration) |
| Invalid serial consistency | Checked in `resolveOptions` before any query | Throw `LockException` at construction time |
| Invalid identifier (keyspace, table, column) | Checked in `resolveOptions` against `^[a-zA-Z_][a-zA-Z0-9_]*$` | Throw `LockException` at construction time |
| LWT contention (Paxos failure) | `OperationTimedOutError` or `WriteFailureError` with `paxos` in `code` | Propagate (caller may retry) |

### Error inspection

`cassandra-driver` throws errors with structured fields. For the provider's purposes, the LWT outcome is the `[applied]` column in the result row, not an exception — the driver does not throw on LWT precondition failure. Only connection/timeout errors throw.

```typescript
// LWT success check
const applied = result.rows[0]['[applied]'] as boolean;
```

### Time representation

`cassandra-driver` maps JavaScript `Date` instances to Cassandra `timestamp` columns. The accessor constructs `Date` objects from epoch millis:

```typescript
function asDate(epochMillis: number): Date {
  return new Date(epochMillis);
}
```

The driver returns `Date` instances when reading `timestamp` columns; comparison uses `date.getTime()` to recover epoch millis.

## Dependencies

- **Peer**: `@tslock/core` `^1.0.0`, `cassandra-driver` `^4.6.0`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers` or `@testcontainers/cassandra` (for integration tests).

### Why peer dependencies

- `cassandra-driver` is the canonical DataStax Node.js driver. Users pin the version; TSLock does not bundle a specific version, avoiding duplicate driver instances and version conflicts.
- `@tslock/core` is peer so the user has a single copy across providers.

## Exports

From `src/index.ts`:
- `CassandraLockProvider`
- `CassandraLockProviderOptions`
- `CassandraColumnNames`
- `createLockTable`

## Integration Tests

Integration tests use `testcontainers` (or `@testcontainers/cassandra`) to spin up a Cassandra container. The test suite extends `storageBasedLockProviderIntegrationTests` from `@tslock/test-support`.

### Container

- Image: `cassandra:4.1` (latest 4.x; Cassandra 4.x has improved LWT performance).
- Port: 9042 (CQL native protocol).
- Startup wait: container ready when `cqlsh` can connect and run `DESCRIBE KEYSPACES` (typically 30-60s — Cassandra takes time to bootstrap).

### Setup

```typescript
beforeAll(async () => {
  container = await new GenericContainer('cassandra:4.1')
    .withExposedPorts(9042)
    .withEnvironment({ CASSANDRA_LISTEN_ADDRESS: 'auto' })
    .withStartupTimeout(180_000)
    .start();
  const client = new cassandra.Client({
    contactPoints: [`${container.getHost()}:${container.getMappedPort(9042)}`],
    localDataCenter: 'datacenter1',
    keyspace: undefined,  // connect without keyspace so we can create one
  });
  await client.connect();
  await client.execute(
    "CREATE KEYSPACE IF NOT EXISTS shedlock_test " +
    "WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}"
  );
  await createLockTable(client, { keyspace: 'shedlock_test' });
  await client.shutdown();

  // Reconnect with the keyspace set
  lockClient = new cassandra.Client({
    contactPoints: [`${container.getHost()}:${container.getMappedPort(9042)}`],
    localDataCenter: 'datacenter1',
    keyspace: 'shedlock_test',
  });
  await lockClient.connect();
  provider = new CassandraLockProvider(lockClient, { keyspace: 'shedlock_test' });
});

afterAll(async () => {
  if (lockClient) await lockClient.shutdown();
  if (container) await container.stop();
});
```

### Test cases

In addition to the shared `storageBasedLockProviderIntegrationTests`, the integration test verifies:
- A direct `INSERT ... IF NOT EXISTS` for an existing lock name returns `[applied] = false`.
- `extend()` from a provider constructed with a different `lockedByValue` returns `false`.
- The lock row exists in the table after `insertRecord` (direct query).

### Single-node caveat

The testcontainer runs a single-node cluster with `replication_factor = 1`. LWT on a single node is effectively a local operation — Paxos still runs but quorum is trivial. This means the integration test verifies *correctness* of the CQL and the `[applied]` handling, but does not exercise multi-node Paxos contention. Multi-node testing is out of scope for the provider test suite; it is the responsibility of the Cassandra driver's own test suite.

## Non-Goals (for this package)

- No multi-DC configuration assistance. The user is responsible for choosing `LOCAL_SERIAL` vs `SERIAL` based on their cluster topology.
- No automatic keyspace creation. The user must provision the keyspace with an appropriate replication strategy.
- No automatic table creation beyond the `createLockTable()` helper. The user is responsible for any operational concerns (gc_grace_seconds, compaction strategy for the small lock table — defaults are fine).
- No support for non-LWT locking (e.g., lightweight counter-based locks). LWT is the only safe single-statement CAS primitive in Cassandra.
- No support for Cassandra 3.x (LWT semantics and `[applied]` result format differ; `cassandra-driver` v4 targets Cassandra 3.11+ but the provider is tested only against 4.x).
- No retries on Paxos contention. The caller (or `LockingTaskExecutor`) decides whether to retry a failed lock attempt. Paxos contention propagates as an exception.
