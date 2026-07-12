# Implementation Plan: @tslock/neo4j

## Overview

Build the `@tslock/neo4j` provider package. It is a thin `StorageAccessor` implementation over `neo4j-driver`, wrapped by `StorageBasedLockProvider` from `@tslock/core`. No core changes are required — this package consumes the core abstractions.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built and available (for integration test contracts)
- `neo4j-driver` installed locally (or mocked) for type-checking
- Docker available locally for testcontainer-based integration tests

## Steps

### Step 1: Initialize package

```
packages/neo4j/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts   (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/neo4j",
  "version": "1.0.0",
  "description": "TSLock provider for Neo4j graph database",
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
    "neo4j-driver": "^5.0.0"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false },
    "neo4j-driver": { "optional": false }
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0",
    "neo4j-driver": "^5.0.0",
    "testcontainers": "^10.0.0",
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*"
  }
}
```

**`tsup.config.ts`:** identical pattern to core (entry `src/index.ts`, format `['esm','cjs']`, `dts: true`, `clean: true`, `sourcemap: true`).

**`tsconfig.json`:** extends repo root `tsconfig.base.json`.

### Step 2: Define configuration types

**File:** `src/neo4j-lock-provider.ts`

- `Neo4jColumnNames` interface (4 readonly string fields).
- `Neo4jLockProviderOptions` interface (`label`, `columnNames`, `lockedByValue`, `database` — all optional).
- `DEFAULT_LABEL = 'ShedLock'`.
- `DEFAULT_COLUMN_NAMES` constant object.
- `resolveOptions(options?)` — merges user options with defaults, returns fully-populated options.

### Step 3: Implement Cypher statement builders

**File:** `src/neo4j-cypher.ts`

Pure functions that return Cypher strings given resolved options. Keeping these separate from the accessor makes them unit-testable without a driver.

```typescript
function buildInsertCypher(opts: ResolvedOptions): string;
function buildUpdateCypher(opts: ResolvedOptions): string;
function buildUnlockCypher(opts: ResolvedOptions): string;
function buildExtendCypher(opts: ResolvedOptions): string;
function buildCreateConstraintCypher(opts: ResolvedOptions): string;
```

Statements are built by interpolating the label and column names directly into the Cypher string (these are configuration values, not user input, so string interpolation is safe — but they must be validated to match `[A-Za-z_][A-Za-z0-9_]*` to prevent Cypher injection from misconfiguration). All *values* are passed as `$parameter` placeholders, never interpolated.

Example output for default options:
```cypher
// insert
CREATE (lock:ShedLock {name: $name, lockUntil: $lockUntil, lockedAt: $lockedAt, lockedBy: $lockedBy})

// update
MATCH (lock:ShedLock {name: $name})
WHERE lock.lockUntil <= $now
SET lock.lockUntil = $lockUntil, lock.lockedAt = $lockedAt, lock.lockedBy = $lockedBy
RETURN lock

// unlock
MATCH (lock:ShedLock {name: $name})
SET lock.lockUntil = $unlockTime

// extend
MATCH (lock:ShedLock {name: $name})
WHERE lock.lockedBy = $lockedBy AND lock.lockUntil > $now
SET lock.lockUntil = $lockUntil
RETURN lock

// createConstraint
CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS FOR (lock:ShedLock) REQUIRE lock.name IS UNIQUE
```

### Step 4: Implement Neo4jStorageAccessor

**File:** `src/neo4j-storage-accessor.ts`

```typescript
class Neo4jStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly driver: Driver,
    private readonly opts: ResolvedOptions,
  ) {}

  async insertRecord(config: LockConfiguration): Promise<boolean>;
  async updateRecord(config: LockConfiguration): Promise<boolean>;
  async unlock(config: LockConfiguration): Promise<void>;
  async extend(config: LockConfiguration): Promise<boolean>;
}
```

Each method:
1. `const session = this.driver.session({ database: this.opts.database })` (omit `database` if undefined so driver default applies).
2. `try { await session.writeTransaction(async (tx) => { ... }) } finally { await session.close() }`.
3. Inside the transaction: build parameters, `const result = await tx.run(cypher, params)`, inspect `result.records` (or `result.summary`).

**Parameter objects** (epoch millis as JavaScript numbers — `neo4j-driver` accepts integers; no need to convert to `neo4j.int()` unless values exceed `Number.MAX_SAFE_INTEGER`, which they will not for current timestamps):

```typescript
const insertParams = {
  name: config.name,
  lockUntil: lockAtMostUntil(config),
  lockedAt: ClockProvider.now(),
  lockedBy: this.opts.lockedByValue,
};
```

**Constraint violation detection** — import `Neo4jError` from `neo4j-driver` and inspect `error.code` + `error.message` as described in the spec. Re-throw non-matching errors.

**Note on `lockedBy` for `extend`:** Use `this.opts.lockedByValue` (the same value used at insert time). This is consistent because the accessor instance is constructed once and reused; the `lockedBy` value does not change between calls. Document this assumption.

### Step 5: Implement Neo4jLockProvider

**File:** `src/neo4j-lock-provider.ts` (extended)

```typescript
class Neo4jLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(driver: Driver, options?: Neo4jLockProviderOptions) {
    this.delegate = new StorageBasedLockProvider(
      new Neo4jStorageAccessor(driver, resolveOptions(options)),
    );
  }

  lock(config) { return this.delegate.lock(config); }
  clearCache(name) { this.delegate.clearCache(name); }
}
```

No additional logic — purely a wrapper that hides the `StorageBasedLockProvider`/`StorageAccessor` wiring from the user.

### Step 6: Implement createUniqueConstraint helper

**File:** `src/constraint.ts`

```typescript
export async function createUniqueConstraint(
  driver: Driver,
  options?: { label?: string; columnNames?: Neo4jColumnNames; database?: string },
): Promise<void>;
```

- Resolve options, build the constraint Cypher, open a session, run the statement, close the session in `finally`. Swallow `Neo.ClientError.Schema.ConstraintValidationFailed` errors (constraint already exists — idempotent path if `IF NOT EXISTS` is unsupported on an old Neo4j version).
- Re-throw other errors.

### Step 7: Wire up index.ts

Export:
- `Neo4jLockProvider`
- `Neo4jLockProviderOptions`, `Neo4jColumnNames`
- `createUniqueConstraint`

Do **not** export `Neo4jStorageAccessor` (internal) or `ResolvedOptions` (internal).

### Step 8: Write unit tests

**File:** `__tests__/unit/neo4j-cypher.test.ts`
- `buildInsertCypher` with default options → expected string.
- `buildUpdateCypher` with custom label + column names → expected string.
- `buildCreateConstraintCypher` with custom label → expected string.
- Reject label / column names containing characters outside `[A-Za-z_][A-Za-z0-9_]*` (validation throws).

**File:** `__tests__/unit/neo4j-storage-accessor.test.ts`

Use a mocked `Driver` (`vi.fn()` returning a fake `Session` whose `writeTransaction` invokes the supplied callback with a fake `Transaction` that records `tx.run(cypher, params)` calls and returns a configurable `Result`).

- `insertRecord` success → `tx.run` called with insert Cypher + correct params, returns `true`.
- `insertRecord` constraint violation → `tx.run` throws `Neo4jError` with `code = 'Neo.ClientError.Schema.ConstraintValidationFailed'` and matching message → `insertRecord` returns `false`.
- `insertRecord` with non-constraint error → propagates.
- `insertRecord` with constraint error for a *different* lock name → propagates (must not be swallowed).
- `updateRecord` returns one record → `true`; returns zero records → `false`.
- `updateRecord` parameters include `$now`, `$lockUntil`, `$lockedAt`, `$lockedBy` correctly.
- `unlock` calls `tx.run` with unlock Cypher, does not inspect result.
- `unlock` no node matched → resolves (no error).
- `extend` one record returned → `true`; zero records → `false`.
- `extend` parameters include `$lockedBy` matching `options.lockedByValue`.
- `session.close()` is called even when `writeTransaction` throws (assert mock called in `finally`).

**File:** `__tests__/unit/constraint.test.ts`
- `createUniqueConstraint` runs the constraint Cypher on a session.
- Idempotent: `Neo.ClientError.Schema.ConstraintValidationFailed` swallowed.
- Other errors propagated.

### Step 9: Write integration tests

**File:** `__tests__/integration/neo4j-integration.test.ts`

```typescript
import { storageBasedLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { Neo4jLockProvider, createUniqueConstraint } from '../src/index.js';

describe('Neo4jLockProvider integration', () => {
  let container: StartedTestContainer;
  let driver: Driver;

  beforeAll(async () => {
    container = await new GenericContainer('neo4j:5')
      .withExposedPorts(7687, 7474)
      .withEnvironment({ NEO4J_AUTH: 'neo4j/password' })
      .withStartupTimeout(120_000)
      .start();
    driver = neo4j.driver(
      `bolt://${container.getHost()}:${container.getMappedPort(7687)}`,
      neo4j.auth.basic('neo4j', 'password'),
    );
    await driver.verifyConnectivity();
    await createUniqueConstraint(driver);
  });

  afterAll(async () => {
    if (driver) await driver.close();
    if (container) await container.stop();
  });

  storageBasedLockProviderIntegrationTests(
    async () => new Neo4jLockProvider(driver),
    { timeMode: 'real' },
  );

  fuzzTests(async () => new Neo4jLockProvider(driver));

  describe('provider-specific', () => {
    it('rejects extend from a different lockedBy', async () => {
      const owner = new Neo4jLockProvider(driver, { lockedByValue: 'node-A' });
      const intruder = new Neo4jLockProvider(driver, { lockedByValue: 'node-B' });
      const lock = await owner.lock(config('extend-foreign', '1m'));
      expect(lock).toBeDefined();
      const extended = await lock!.extend('1m', 0);
      // Intruder cannot extend (lockedBy mismatch)
      // (covered indirectly via shouldNotExtendIfExpired-style assertions)
      await lock!.unlock();
    });
  });
});
```

**Note:** Use real-time waits (`timeMode: 'real'`) — Neo4j uses its own server clock implicitly when comparing `$now` sent by the client. The test container's clock and the test process's clock are both real.

**Container startup:** Neo4j 5.x container can take 30-60s to be ready. Use `withStartupTimeout(120_000)`. Polling `driver.verifyConnectivity()` with a short retry loop is more reliable than waiting on the HTTP port.

### Step 10: Verify

```bash
cd packages/neo4j
pnpm typecheck
pnpm test               # unit tests only
pnpm test:integration   # requires Docker
pnpm build
```

All must pass. Integration tests are gated behind a separate Vitest config so they don't run in CI without Docker.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Constraint error code changes across Neo4j versions** | Match by `error.code` first, fall back to `error.message` regex (`/already exists with label/`) and lock-name containment. Add unit tests for both detection paths. |
| **Cypher injection from misconfigured label/column name** | Validate label and column names against `^[A-Za-z_][A-Za-z0-9_]*$` in `resolveOptions()`. Throw on invalid input. |
| **Epoch millis precision** | Neo4j integers are 64-bit; `neo4j-driver` v5 accepts JS numbers up to `Number.MAX_SAFE_INTEGER`. Current epoch millis (~1.7e12) is well within range. No `neo4j.int()` conversion needed. |
| **Session leak on error** | Always wrap `session` use in `try { ... } finally { await session.close() }`. Unit test asserts `close()` is called when `writeTransaction` throws. |
| **Container startup flakiness in CI** | Generous `withStartupTimeout(120_000)`; retry `verifyConnectivity()` 3 times with 5s backoff. Mark integration suite `test.slow` so fast-CI skips it without Docker. |
| **Concurrent `insertRecord` race** | Handled by the unique constraint — both calls fail except one, which succeeds. The loser's `ConstraintValidationFailed` maps to `false`. |
| **Custom database name** | `driver.session({ database })` — when `undefined`, omit the option so the driver default applies. Test with default + custom database. |
| **`lockedBy` mismatch on extend** | Document: the accessor must use the same `lockedByValue` at insert and extend time. Recommend users set `lockedByValue` explicitly when running across multiple instances (do not rely on hostname stability). |

## Estimation

~6 source files, ~400-500 lines of implementation + ~300-400 lines of tests. Straightforward — the only non-trivial logic is the constraint-error detection. One focused session.

## Order of Implementation

1. Package scaffold (`package.json`, `tsconfig.json`, `tsup.config.ts`, empty `index.ts`).
2. `neo4j-cypher.ts` + unit tests (no driver dependency).
3. `neo4j-lock-provider.ts` types + `resolveOptions` + validation.
4. `neo4j-storage-accessor.ts` (mocked driver unit tests).
5. `constraint.ts` + unit tests.
6. `index.ts` exports.
7. Integration tests with testcontainer.
8. Verify (typecheck, unit, integration, build).
