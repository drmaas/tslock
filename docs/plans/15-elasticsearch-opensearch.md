# Implementation Plan: @tslock/elasticsearch + @tslock/opensearch

## Overview

Build two provider packages — `@tslock/elasticsearch` and `@tslock/opensearch` — that share the same locking mechanism (Painless script + `upsert` + `refresh: 'wait_for'`) but use different drivers. Build the `elasticsearch` package first; the `opensearch` package is a near-copy with the driver import swapped and class names renamed.

## Prerequisites

- `@tslock/core` and `@tslock/test-support` built and available in the workspace
- `@elastic/elasticsearch` and `@opensearch-project/opensearch` installed as dev deps for type-checks and tests
- `testcontainers` available (Elasticsearch and OpenSearch testcontainer images both supported)
- Docker available for integration test runs

## Steps

### Step 1: Initialize elasticsearch package structure

```
packages/elasticsearch/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/elasticsearch",
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
  "peerDependencies": { "@tslock/core": "workspace:*", "@elastic/elasticsearch": "^8.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "@elastic/elasticsearch": "^8.0.0",
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

### Step 2: Implement field-names module

**File:** `src/field-names.ts`

```typescript
export interface ElasticsearchFieldNames {
  lockUntil: string;
  lockedAt: string;
  lockedBy: string;
}

export const FieldNames = {
  DEFAULT: { lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy' } as const,
  SNAKE_CASE: { lockUntil: 'lock_until', lockedAt: 'locked_at', lockedBy: 'locked_by' } as const,
};
```

Field names are passed into the Painless script as `params` (not string-interpolated into the source) to avoid recompiling scripts per name. This is an Elasticsearch performance concern — scripts with the same source are cached; string-interpolated sources would be distinct scripts and defeat caching.

### Step 3: Implement ElasticsearchAccessor

**File:** `src/elasticsearch-accessor.ts`

- Import `Client` type from `@elastic/elasticsearch`.
- Constructor: `(client: Client, index: string, fieldNames: ElasticsearchFieldNames)`.
- Helper `isConflictError(e)`: returns `true` if `e?.meta?.statusCode === 409 || e?.statusCode === 409 || (e?.name === 'ResponseError' && e?.meta?.statusCode === 409)`. Covers v8 driver shapes.
- Helper `isNotFoundError(e)`: same idea for `404` and `result === 'not_found'`.
- `lock(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname();`
  2. Build ISO strings: `isoNow`, `isoLockUntil = Utils.toIsoString(lockAtMostUntil(config))`.
  3. `try { const response = await client.update({ id: config.name, index, refresh: 'wait_for', body: { script: { source: LOCK_SCRIPT_SOURCE, params: { now: isoNow, lockUntil: isoLockUntil, lockedAt: isoNow, lockedBy: hostname, lockUntilField, lockedAtField, lockedByField } }, upsert: { [lockUntilField]: isoLockUntil, [lockedAtField]: isoNow, [lockedByField]: hostname } } });`
  4. If `response.result === 'noop'` → return `undefined`.
  5. Return `new ElasticsearchLock(config, this)`.
  6. `catch (e)`: if `isConflictError(e)` → return `undefined`; else rethrow.
- `extend(config)`:
  1. Same pattern; script source = `EXTEND_SCRIPT_SOURCE`.
  2. Params: `now`, `lockUntil` (new), `lockedBy`, `lockUntilField`, `lockedByField`.
  3. No `upsert`.
  4. On `noop` → `undefined`. On `not_found` → `undefined` (treat as extend failure).
  5. On `isConflictError` → `undefined`.
- `unlock(config)`:
  1. `isoUnlock = Utils.toIsoString(unlockTime(config))`.
  2. `try { await client.update({ id: config.name, index, refresh: 'wait_for', body: { script: { source: UNLOCK_SCRIPT_SOURCE, params: { unlockTime: isoUnlock, lockUntilField } } } }); }`
  3. `catch (e)`: if `isNotFoundError(e)` → return (swallow); else rethrow.

Define the three script sources as module-level string constants to keep them DRY and easy to diff against ShedLock's Java source.

### Step 4: Implement ElasticsearchLock

**File:** `src/elasticsearch-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class ElasticsearchLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: ElasticsearchAccessor, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock()` → `await this.accessor.unlock(this.config)`
  - `protected async doExtend(newConfig)` → `return await this.accessor.extend(newConfig)`

### Step 5: Implement ElasticsearchLockProvider

**File:** `src/elasticsearch-lock-provider.ts`

- `import type { Client } from '@elastic/elasticsearch'`
- `class ElasticsearchLockProvider implements ExtensibleLockProvider`:
  - `private readonly accessor: ElasticsearchAccessor`
  - `constructor(client: Client, options?: ElasticsearchLockProviderOptions)`:
    1. `const index = options?.index ?? 'shedlock'`
    2. `const fieldNames = options?.fieldNames ?? FieldNames.DEFAULT`
    3. `this.accessor = new ElasticsearchAccessor(client, index, fieldNames)`
  - `async lock(config)` → `return await this.accessor.lock(config)`

Note: ShedLock's ES provider does not implement extend, so it is not `ExtensibleLockProvider` in Java. TSLock adds extend (the script is trivial), so we declare `implements ExtensibleLockProvider`. This lets `KeepAliveLockProvider` wrap these providers.

### Step 6: Wire elasticsearch index.ts

**File:** `src/index.ts`

Export:
- `ElasticsearchLockProvider`
- `ElasticsearchLockProviderOptions`
- `ElasticsearchFieldNames`
- `FieldNames`

Do NOT export `ElasticsearchAccessor` or `ElasticsearchLock`.

### Step 7: Write elasticsearch unit tests (mocked Client)

**File:** `__tests__/elasticsearch-lock-provider.test.ts`

Mock the `Client`: `const update = vi.fn(); const client = { update } as unknown as Client;`. Use `new ElasticsearchLockProvider(client, { index: 'shedlock-test' })`.

- `lock()`:
  - `update` resolves with `{ result: 'updated' }` → `ElasticsearchLock` returned.
  - `update` resolves with `{ result: 'created' }` → `ElasticsearchLock` returned (upsert path).
  - `update` resolves with `{ result: 'noop' }` → `undefined`.
  - `update` rejects with `{ meta: { statusCode: 409 } }` → `undefined`.
  - `update` rejects with other error → propagates.
  - Assert `refresh: 'wait_for'` is passed.
  - Assert `body.script.params.lockUntilField === 'lockUntil'` for `FieldNames.DEFAULT`, `'lock_until'` for `FieldNames.SNAKE_CASE`.
  - Assert ISO strings in params.
- `extend()`:
  - `{ result: 'updated' }` → lock returned.
  - `{ result: 'noop' }` → `undefined`.
  - `{ result: 'not_found' }` → `undefined`.
  - Assert script params include `lockedByField` and `lockUntilField`.
- `unlock()`:
  - Assert script source uses `params.unlockTime` and `params.lockUntilField`.
  - `{ result: 'not_found' }` → swallowed (no throw).
  - Rejects with `{ meta: { statusCode: 404 } }` → swallowed.
  - Rejects with other → propagates.
- Field-name casing: run a second suite with `FieldNames.SNAKE_CASE`; assert `upsert` keys and `params.lockUntilField` use snake_case.

### Step 8: Write elasticsearch integration tests

**File:** `__tests__/integration/elasticsearch-lock-provider.integration.test.ts`

- Use `testcontainers` Elasticsearch image:
  ```typescript
  import { ElasticsearchContainer } from '@testcontainers/elasticsearch';
  const container = await new ElasticsearchContainer('docker.elastic.co/elasticsearch/elasticsearch:8.11.0').start();
  const client = new Client({ node: container.getUrl() });
  ```
- `beforeAll`:
  1. Start container.
  2. Create client.
  3. `await client.indices.create({ index: 'shedlock-test' })`.
  4. `provider = new ElasticsearchLockProvider(client, { index: 'shedlock-test' })`.
- `afterAll`: `await client.indices.delete({ index: 'shedlock-test' })`, close client, stop container.
- `beforeEach`: `await client.deleteByQuery({ index: 'shedlock-test', body: { query: { match_all: {} } } })` (refresh: true), reset `ClockProvider`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })` and `extensibleLockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.

### Step 9: Verify elasticsearch package end-to-end

```bash
cd packages/elasticsearch
pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
```

### Step 10: Initialize opensearch package (copy + swap driver)

```
packages/opensearch/
├── package.json (name: @tslock/opensearch, peer: @opensearch-project/opensearch)
├── tsconfig.json
├── tsup.config.ts
└── src/...
```

**`package.json`** (opensearch):
```json
{
  "name": "@tslock/opensearch",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "test": "vitest run", "test:integration": "vitest run --config vitest.integration.config.ts", "typecheck": "tsc --noEmit" },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*", "@opensearch-project/opensearch": "^2.0.0" },
  "devDependencies": { "@opensearch-project/opensearch": "^2.0.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0" }
}
```

- Copy `elasticsearch/src` → `opensearch/src`.
- Replace `@elastic/elasticsearch` imports with `@opensearch-project/opensearch`.
- Rename classes: `ElasticsearchLockProvider` → `OpenSearchLockProvider`, `ElasticsearchLock` → `OpenSearchLock`, `ElasticsearchAccessor` → `OpenSearchAccessor`, `ElasticsearchFieldNames` → `OpenSearchFieldNames`.
- The `field-names.ts` file is identical (just rename the interface type to `OpenSearchFieldNames`).
- The Painless script source is identical (OpenSearch runs the same Painless dialect).
- `isConflictError` / `isNotFoundError` helpers: same logic; verify against the OpenSearch client's error shape (the `@opensearch-project/opensearch` client also exposes `ResponseError` with `meta.statusCode`).

### Step 11: Write opensearch tests

- Unit tests: copy + swap driver mock. The mock shape is the same (`client.update: vi.fn()`).
- Integration tests: use the OpenSearch Docker image via `GenericContainer`:
  ```typescript
  import { GenericContainer } from 'testcontainers';
  const container = await new GenericContainer('opensearchproject/opensearch:2.11.0')
    .withEnvironment({ 'discovery.type': 'single-node', 'DISABLE_SECURITY_PLUGIN': 'true' })
    .withExposedPorts(9200)
    .start();
  const client = new Client({
    node: `https://${container.getHost()}:${container.getMappedPort(9200)}`,
    ssl: { rejectUnauthorized: false },
  });
  ```

### Step 12: Verify opensearch package end-to-end

```bash
cd packages/opensearch
pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
```

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `@elastic/elasticsearch` v8 `body` shape changes (v8 removed `body` from some methods) | `client.update` still accepts the `body` argument in v8; verify with installed version. If not, switch to flat-params shape (`script`, `upsert` as top-level args). Pin the major in `peerDependencies`. Add a unit test that asserts the request shape the mock receives. |
| Painless script error semantics (`ctx.op = 'none'` returns `noop`) | Test against a real container. The script is borrowed verbatim from ShedLock which has used it in production for years. |
| 409 conflict detection differs across driver error shapes | `isConflictError` helper covers `meta.statusCode`, `statusCode`, and `name === 'ResponseError'` shapes. Add unit tests for each shape. |
| `refresh: 'wait_for'` waits up to the cluster's `index.max_refresh_listeners` (default 1000) | For high-concurrency lock attempts this could throttle; in tests with 50 concurrent locks (fuzz test) it is fine. Document the limit in the README. |
| OpenSearch Docker image security plugin blocks unauthenticated calls | Set `DISABLE_SECURITY_PLUGIN: 'true'` in the testcontainer env. Document that production users configure TLS/auth on the `Client` constructor. |
| Index mapping strictness rejects unknown fields | Tests create the index with a dynamic mapping (default) so the lock fields are accepted. Document that production indexes should map the lock fields as `date` or `keyword` per the user's preference. |
| Field name duplication across both packages | Intentional — driver types are incompatible. Keep the two accessors in sync via a code-review checklist. The script logic is stable; divergence is unlikely. |
| `ctx.op = 'none'` is the same in both engines | Verified — Painless is shared between ES and OpenSearch. No risk. |
| `extend()` on a non-existent doc returns `not_found` (no `upsert`) | Treat `not_found` as `undefined` (extend failure). Unit test covers this case. |
| Script source as a string constant vs inline | Module-level string constants for the three scripts make diffing against ShedLock's Java source easy and keep the accessor methods short. Decision: constants. |

## Estimation

~10 source files total (5 per package), ~500-700 lines of implementation (mostly duplicated) + ~600-800 lines of tests (mostly duplicated). One focused session with Docker.

## Order of Implementation

1. `elasticsearch` package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `field-names.ts` (`ElasticsearchFieldNames` + `FieldNames.DEFAULT` / `FieldNames.SNAKE_CASE`)
3. `ElasticsearchAccessor` (lock, extend, unlock + `isConflictError` / `isNotFoundError` helpers + module-level script source constants)
4. `ElasticsearchLock`
5. `ElasticsearchLockProvider`
6. `index.ts` exports
7. Unit tests (mocked `Client`) — cover `FieldNames.DEFAULT` and `FieldNames.SNAKE_CASE`
8. Integration tests (Elasticsearch testcontainer)
9. Verify `elasticsearch` end-to-end
10. Copy `elasticsearch/` → `opensearch/`, swap driver imports, rename classes
11. Opensearch unit + integration tests
12. Verify `opensearch` end-to-end
