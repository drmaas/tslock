# Spec: @tslock/neo4j

## Overview

The `@tslock/neo4j` package provides a distributed lock provider backed by [Neo4j](https://neo4j.com/) graph database. It uses the `StorageBasedLockProvider` pattern from `@tslock/core` with a `StorageAccessor` implementation that issues Cypher queries against a dedicated `:ShedLock` node label.

Lock uniqueness is enforced by a Neo4j unique constraint on the lock name. Insert attempts fail on constraint violation (lock already exists); update attempts only succeed if the existing lock record has expired (`lockUntil <= now`). Extend verifies ownership via `lockedBy`.

This is a direct port of ShedLock's `Neo4jLockProvider`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/neo4j` |
| **Dependencies** | `@tslock/core` (peer), `neo4j-driver` (peer) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. Neo4jLockProvider

```typescript
import type { Driver } from 'neo4j-driver';
import { StorageBasedLockProvider, ExtensibleLockProvider } from '@tslock/core';

class Neo4jLockProvider implements ExtensibleLockProvider {
  constructor(driver: Driver, options?: Neo4jLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  clearCache(name: string): void;
}
```

**Constructor:**
- `driver` — a `neo4j-driver` `Driver` instance (session source). The caller is responsible for driver lifecycle (creation, closing).
- `options` — optional configuration (see below). Defaults are applied for omitted fields.

**Behavior:** Delegates to `new StorageBasedLockProvider(new Neo4jStorageAccessor(driver, options))`. The provider is `ExtensibleLockProvider` because `extend()` is supported.

### 2. Neo4jLockProviderOptions

```typescript
interface Neo4jLockProviderOptions {
  readonly label?: string;                   // default: 'ShedLock'
  readonly columnNames?: Neo4jColumnNames;    // default: see below
  readonly lockedByValue?: string;            // default: Utils.getHostname()
  readonly database?: string;                 // default: undefined (uses driver default)
}

interface Neo4jColumnNames {
  readonly name: string;        // default: 'name'
  readonly lockUntil: string;  // default: 'lockUntil'
  readonly lockedAt: string;    // default: 'lockedAt'
  readonly lockedBy: string;    // default: 'lockedBy'
}
```

- **`label`** — the Neo4j node label used to store lock records. The unique constraint (see Setup) must match this label.
- **`columnNames`** — property names on the lock node. Allows collision avoidance if the host schema already uses the default names.
- **`lockedByValue`** — value written to the `lockedBy` property. Defaults to the current hostname. Used by `extend()` to verify ownership.
- **`database`** — Neo4j database name to run queries against. When omitted, the driver's default database is used (requires Neo4j 4.x+).

### 3. Exported Helpers

```typescript
export function createUniqueConstraint(
  driver: Driver,
  options?: { label?: string; columnNames?: Neo4jColumnNames; database?: string },
): Promise<void>;
```

Executes the unique constraint creation statement. Provided as a convenience for application startup; idempotent (uses `IF NOT EXISTS`). Users may instead run the statement directly against their Neo4j instance.

## Locking Mechanism

All operations use a single `Session` (obtained from `driver.session()`) per call, with explicit `write` transaction. Sessions are closed in a `finally` block.

### insertRecord(config)

Executed when the lock name has not been seen before by the in-memory `LockRecordRegistry`. Creates a new lock node; the unique constraint on `name` guarantees at-most-one insert across concurrent instances.

```cypher
CREATE (lock:ShedLock {
  name: $name,
  lockUntil: $lockUntil,
  lockedAt: $lockedAt,
  lockedBy: $lockedBy
})
```

**Parameters:**
- `$name` — `config.name`
- `$lockUntil` — `lockAtMostUntil(config)` (epoch millis as integer)
- `$lockedAt` — `ClockProvider.now()` (epoch millis as integer)
- `$lockedBy` — `options.lockedByValue ?? Utils.getHostname()`

**Result handling:**
- Success → return `true`.
- `Neo4jError` with `Neo.ClientError.Schema.ConstraintValidationFailed` and message containing `already exists with label` and the lock name → return `false` (lock already held). Constraint violation is detected by inspecting `error.code` and/or `error.message`.
- Other errors → propagate.

### updateRecord(config)

Executed when `insertRecord` either failed (record exists) or when the lock name is already in the registry. Updates the existing lock node only if its `lockUntil` has passed (the lock is expired).

```cypher
MATCH (lock:ShedLock {name: $name})
WHERE lock.lockUntil <= $now
SET lock.lockUntil = $lockUntil,
    lock.lockedAt   = $lockedAt,
    lock.lockedBy   = $lockedBy
RETURN lock
```

**Parameters:**
- `$name` — `config.name`
- `$now` — `ClockProvider.now()` (epoch millis as integer)
- `$lockUntil` — `lockAtMostUntil(config)`
- `$lockedAt` — `ClockProvider.now()`
- `$lockedBy` — `options.lockedByValue ?? Utils.getHostname()`

**Result handling:**
- `summary` contains at least one record (one node returned) → return `true`.
- No records returned → return `false` (lock is still valid and held by someone else).
- Errors → propagate.

### unlock(config)

Sets `lockUntil` to `unlockTime(config)` — the later of "now" and `lockAtLeastUntil(config)`. This implements `lockAtLeastFor`: if the task finished very quickly, the lock remains reserved until the minimum hold time elapses.

```cypher
MATCH (lock:ShedLock {name: $name})
SET lock.lockUntil = $unlockTime
```

**Parameters:**
- `$name` — `config.name`
- `$unlockTime` — `unlockTime(config)` (epoch millis as integer)

**Result handling:**
- Always succeeds if the node exists. If the node was deleted externally, the `MATCH` simply matches zero nodes — the unlock is a no-op. This is acceptable; a stuck lock would have expired via `lockAtMostFor` anyway.
- Errors → propagate. `DefaultLockingTaskExecutor` catches unlock errors and logs them so the task result is not affected.

### extend(config)

Extends the lock only if the current instance still owns it and the lock is still valid. Ownership is verified via the `lockedBy` property.

```cypher
MATCH (lock:ShedLock {name: $name})
WHERE lock.lockedBy = $lockedBy AND lock.lockUntil > $now
SET lock.lockUntil = $lockUntil
RETURN lock
```

**Parameters:**
- `$name` — `config.name`
- `$lockedBy` — the original `lockedBy` value (the hostname that holds the lock — stored from the moment the lock was acquired, passed via the `LockConfiguration`'s context)
- `$now` — `ClockProvider.now()`
- `$lockUntil` — `lockAtMostUntil(config)` (new `lockAtMostFor` applied from now)

**Result handling:**
- At least one record returned → return `true`.
- No records returned → return `false` (lock expired or stolen).
- Errors → propagate.

**Note on `lockedBy`:** The accessor must use the same `lockedBy` value that was written at lock time. Because `StorageBasedLockProvider` returns a `StorageLock` bound to the original `LockConfiguration`, the extend path has access to the original config. The accessor reads `options.lockedByValue` (or `Utils.getHostname()`) at extend time; this requires the hostname to be stable across the lifetime of the lock. This matches ShedLock's behavior.

## Configuration

### Default values

| Option | Default |
|---|---|
| `label` | `'ShedLock'` |
| `columnNames.name` | `'name'` |
| `columnNames.lockUntil` | `'lockUntil'` |
| `columnNames.lockedAt` | `'lockedAt'` |
| `columnNames.lockedBy` | `'lockedBy'` |
| `lockedByValue` | `Utils.getHostname()` |
| `database` | `undefined` (driver default) |

### Validation

- `label` must be a non-empty string matching a valid Neo4j label name.
- All column names must be non-empty strings matching valid Neo4j property names.
- The application is responsible for ensuring the unique constraint exists on the configured label + name column before the provider is used (see Setup).

## Setup Requirements

The user (or the exported `createUniqueConstraint()` helper) must create a unique constraint on the lock name property before the first lock attempt. Without this constraint, concurrent `insertRecord` calls would both succeed, breaking the at-most-once guarantee.

```cypher
CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS
FOR (lock:ShedLock)
REQUIRE lock.name IS UNIQUE
```

If a non-default `label` or `columnNames.name` is configured, the constraint statement must use the same values:

```cypher
CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS
FOR (lock:<label>)
REQUIRE lock.<columnNames.name> IS UNIQUE
```

**Recommendation:** Run the constraint creation at application startup. The `IF NOT EXISTS` clause makes it safe to run repeatedly.

**No other schema is required.** Lock nodes are created on demand by `insertRecord`. There is no upfront table/index creation beyond the unique constraint.

## File Structure

```
packages/neo4j/
├── src/
│   ├── index.ts                    # public exports
│   ├── neo4j-lock-provider.ts       # Neo4jLockProvider, Neo4jLockProviderOptions
│   ├── neo4j-storage-accessor.ts    # Neo4jStorageAccessor extends AbstractStorageAccessor
│   ├── neo4j-cypher.ts              # Cypher statement builders (parameterized)
│   └── constraint.ts               # createUniqueConstraint helper
├── __tests__/
│   ├── unit/
│   │   ├── neo4j-storage-accessor.test.ts   # mocked Driver / Session
│   │   ├── neo4j-cypher.test.ts             # statement building
│   │   └── constraint.test.ts               # mocked constraint creation
│   └── integration/
│       ├── neo4j-integration.test.ts        # extends storageBasedLockProviderIntegrationTests
│       └── docker-compose.yml               # Neo4j testcontainer config
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling

| Situation | Detection | Behavior |
|---|---|---|
| Lock held (unique constraint violation on insert) | `Neo4jError` with `code === 'Neo.ClientError.Schema.ConstraintValidationFailed'` (or message contains `already exists with label` and the lock name) | `insertRecord` returns `false` |
| Lock held (no node matched on update) | `summary` has zero records | `updateRecord` returns `false` |
| Lock expired or not owned (no node matched on extend) | `summary` has zero records | `extend` returns `false` |
| Unlock against missing node (node deleted externally) | `MATCH` matches zero nodes | No-op, returns `void` (not an error) |
| Connection / network error | Any other `Neo4jError` | Propagate |
| Auth error | `Neo.ClientError.Security.Unauthorized` | Propagate |
| Database not found | `Neo.ClientError.Database.DatabaseNotFound` | Propagate |
| Session lifecycle error | `session.close()` throws in `finally` | Propagate (the original error from the transaction is preserved if both occur; secondary errors are logged) |

### Error inspection

The `neo4j-driver` throws `Neo4jError` instances with a `code` field following the `Neo.<Severity>.<Category>.<Title>` convention. The accessor matches constraint violations as:

```typescript
function isConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Neo4jError)) return false;
  return (
    error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed' &&
    !!error.message.match(/already exists with label/) &&
    error.message.includes(lockName)
  );
}
```

The `error.message.includes(lockName)` check avoids misclassifying a constraint violation on a *different* unique constraint that happens to share the same error code (e.g., if the user has other constraints on the same label). ShedLock's Java provider uses the same check.

## Dependencies

- **Peer**: `@tslock/core` `^1.0.0`, `neo4j-driver` `^5.0.0`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers` (for integration tests)

### Why peer dependencies

- `neo4j-driver` is the canonical Neo4j client. Users install the version they pin; TSLock does not bundle a specific version, avoiding duplicate driver instances and version conflicts.
- `@tslock/core` is peer so the user has a single `@tslock/core` across all providers they use (no duplicate copies of `AsyncLocalStorage`).

## Exports

From `src/index.ts`:
- `Neo4jLockProvider`
- `Neo4jLockProviderOptions`
- `Neo4jColumnNames`
- `createUniqueConstraint`

## Integration Tests

Integration tests use the `testcontainers` npm package to spin up a Neo4j container. The test suite extends `storageBasedLockProviderIntegrationTests` from `@tslock/test-support`.

### Container

- Image: `neo4j:5` (latest 5.x).
- Ports: 7687 (Bolt) + 7474 (HTTP).
- Environment: `NEO4J_AUTH=neo4j/password` (or `neo4j/neo4j` for test-only).
- Startup wait: container ready when Bolt port accepts connections.

### Setup

```typescript
beforeAll(async () => {
  container = await new GenericContainer('neo4j:5')
    .withExposedPorts(7687, 7474)
    .withEnvironment({ NEO4J_AUTH: 'neo4j/password' })
    .start();
  driver = neo4j.driver(
    `bolt://${container.getHost()}:${container.getMappedPort(7687)}`,
    neo4j.auth.basic('neo4j', 'password'),
  );
  await createUniqueConstraint(driver);
});

afterAll(async () => {
  await driver.close();
  await container.stop();
});
```

### Test cases

In addition to the shared `storageBasedLockProviderIntegrationTests`, the integration test verifies:
- The unique constraint is in place (constraint name query).
- A direct insert of a second lock node with the same name fails with the expected error code.
- `extend()` from a different `lockedByValue` (simulated by constructing a second provider with a different hostname) returns `false`.

## Non-Goals (for this package)

- No transaction-based locking (e.g., `MATCH ... FOR UPDATE`). The constraint + filter approach is sufficient and matches ShedLock.
- No automatic schema migration beyond the unique constraint helper. Users are responsible for any operational concerns (label quotas, schema isolation across tenants).
- No read-replica routing. All queries run on the driver's default routing; for clustered Neo4j, writes are routed to the leader by the driver.
- No support for Neo4j 3.x (which lacks `IF NOT EXISTS` on `CREATE CONSTRAINT`). Requires Neo4j 4.1+ for the constraint helper.
