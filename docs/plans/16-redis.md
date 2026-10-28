# Implementation Plan: @tslock/redis-core + @tslock/redis + @tslock/redis-ioredis

## Overview

Build three packages:
1. **`@tslock/redis-core`** — shared `InternalRedisLockProvider`, `RedisTemplate` interface, `RedisLock`, and Lua scripts. Zero Redis client deps. Build first.
2. **`@tslock/redis`** — `node-redis` adapter (`NodeRedisTemplate` + `NodeRedisLockProvider`). Depends on `redis-core` + the `redis` driver.
3. **`@tslock/redis-ioredis`** — `ioredis` adapter (`IoRedisTemplate` + `IoRedisLockProvider`). Depends on `redis-core` + the `ioredis` driver. Near-copy of the `node-redis` adapter with the driver swapped.

The `redis-core` package is the meat; the two adapters are thin wrappers.

## Prerequisites

- `@tslock/core` and `@tslock/test-support` built and available in the workspace
- `redis` and `ioredis` drivers installed as dev deps for type-checks and tests
- `testcontainers` available at repo root for integration tests
- Docker available for integration test runs

## Steps

### Step 1: Initialize redis-core package structure

```
packages/redis-core/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/redis-core",
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
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": { "vitest": "^2.0.0", "typescript": "^5.5.0" }
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

### Step 2: Implement constants

**File:** `src/constants.ts`

```typescript
export const DEFAULT_KEY_PREFIX = 'job-lock';
export const ENV_DEFAULT = 'default';
```

### Step 3: Implement Lua scripts

**File:** `src/redis-lua-scripts.ts`

```typescript
export const DEL_LUA_SCRIPT = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
export const UPD_LUA_SCRIPT = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end`;
```

Module-level constants. Diff against ShedLock's Java source to confirm byte-for-byte parity.

### Step 4: Implement RedisTemplate interface

**File:** `src/redis-template.ts`

```typescript
export interface RedisTemplate {
  setIfAbsent(key: string, value: string, expireMillis: number): Promise<boolean>;
  setIfPresent(key: string, value: string, expireMillis: number): Promise<boolean>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
}
```

### Step 5: Implement RedisLockProviderConfig

Define in `src/internal-redis-lock-provider.ts` (or a separate `src/redis-lock-provider-config.ts`):

```typescript
export interface RedisLockProviderConfig {
  keyPrefix?: string;
  env?: string;
  safeUpdate?: boolean;
}
```

Defaults resolved in the provider constructor:
- `keyPrefix = config?.keyPrefix ?? DEFAULT_KEY_PREFIX`
- `env = config?.env ?? ENV_DEFAULT`
- `safeUpdate = config?.safeUpdate ?? true`

### Step 6: Implement RedisLock

**File:** `src/redis-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class RedisLock extends AbstractSimpleLock`:
  - `constructor(
      private readonly template: RedisTemplate,
      private readonly key: string,
      private readonly value: string,
      config: LockConfiguration,
      private readonly safeUpdate: boolean,
    )` — pass `config` to `super(config)`.
  - `protected async doUnlock(): Promise<void>`:
    1. If `this.config.lockAtLeastFor <= 0`:
       a. If `this.safeUpdate` → `await this.template.eval(DEL_LUA_SCRIPT, [this.key], [this.value])`
       b. Else → `await this.template.delete(this.key)`
    2. Else → `await this.template.setIfPresent(this.key, this.value, this.config.lockAtLeastFor)`
  - `protected async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined>`:
    1. `const expireMillis = newConfig.lockAtMostFor;`
    2. `let ok: boolean;`
    3. If `this.safeUpdate`:
       - `const result = await this.template.eval(UPD_LUA_SCRIPT, [this.key], [this.value, String(expireMillis)]);`
       - `ok = Number(result) === 1;`
    4. Else → `ok = await this.template.setIfPresent(this.key, this.value, expireMillis);`
    5. If `!ok` → return `undefined`.
    6. Return `new RedisLock(this.template, this.key, this.value, newConfig, this.safeUpdate)`.

### Step 7: Implement InternalRedisLockProvider

**File:** `src/internal-redis-lock-provider.ts`

- `import { LockConfiguration, SimpleLock, ExtensibleLockProvider, ClockProvider, Utils } from '@tslock/core'`
- `import { randomUUID } from 'node:crypto'`
- `class InternalRedisLockProvider implements ExtensibleLockProvider`:
  - `private readonly keyPrefix: string;`
  - `private readonly env: string;`
  - `private readonly safeUpdate: boolean;`
  - `constructor(
      private readonly template: RedisTemplate,
      config?: RedisLockProviderConfig,
    )`:
    - `this.keyPrefix = config?.keyPrefix ?? DEFAULT_KEY_PREFIX;`
    - `this.env = config?.env ?? ENV_DEFAULT;`
    - `this.safeUpdate = config?.safeUpdate ?? true;`
  - `async lock(config: LockConfiguration): Promise<SimpleLock | undefined>`:
    1. `const now = ClockProvider.now();`
    2. `const hostname = Utils.getHostname();`
    3. `const key = `${this.keyPrefix}:${this.env}:${config.name}`;`
    4. `const value = `ADDED:${Utils.toIsoString(now)}@${hostname}:${randomUUID()}`;`
    5. `const ok = await this.template.setIfAbsent(key, value, config.lockAtMostFor);`
    6. If `!ok` → return `undefined`.
    7. Return `new RedisLock(this.template, key, value, config, this.safeUpdate)`.

### Step 8: Wire redis-core index.ts

**File:** `src/index.ts`

Export:
- `InternalRedisLockProvider`
- `RedisLockProviderConfig`
- `RedisTemplate`
- `RedisLock`
- `DEFAULT_KEY_PREFIX`
- `ENV_DEFAULT`
- `DEL_LUA_SCRIPT`, `UPD_LUA_SCRIPT` (for testing/inspection)

### Step 9: Write redis-core unit tests (mocked RedisTemplate)

**File:** `__tests__/internal-redis-lock-provider.test.ts`

Build a mock `RedisTemplate`: `const template = { setIfAbsent: vi.fn(), setIfPresent: vi.fn(), eval: vi.fn(), delete: vi.fn(), get: vi.fn() };`. Use `ClockProvider.setClock(() => fixedTime)` for deterministic timestamps.

- `lock()`:
  - `setIfAbsent` returns `true` → `RedisLock` returned.
  - Assert `key === 'job-lock:default:test'` (default prefix + env).
  - Assert `value` matches `ADDED:<isoNow>@<hostname>:<uuid>` shape (regex).
  - `setIfAbsent` returns `false` → `undefined`.
  - Custom `keyPrefix` / `env` → assert key reflects them.
  - Assert `setIfAbsent` called with `(key, value, config.lockAtMostFor)`.

**File:** `__tests__/redis-lock.test.ts`

- `doUnlock` (`lockAtLeastFor <= 0`, `safeUpdate = true`):
  - Assert `template.eval` called with `(DEL_LUA_SCRIPT, [key], [value])`.
- `doUnlock` (`lockAtLeastFor <= 0`, `safeUpdate = false`):
  - Assert `template.delete` called with `key`. `eval` NOT called.
- `doUnlock` (`lockAtLeastFor > 0`):
  - Assert `template.setIfPresent` called with `(key, value, lockAtLeastFor)`. `eval` and `delete` NOT called.
- `doExtend` (`safeUpdate = true`):
  - `eval` returns `1` (number) → `RedisLock` returned.
  - `eval` returns `'1'` (string) → `RedisLock` returned (Number coercion).
  - `eval` returns `0` → `undefined`.
  - `eval` returns `null` → `undefined`.
  - Assert `eval` called with `(UPD_LUA_SCRIPT, [key], [value, String(expireMillis)])`.
- `doExtend` (`safeUpdate = false`):
  - `setIfPresent` returns `true` → `RedisLock` returned.
  - `setIfPresent` returns `false` → `undefined`.
  - Assert `setIfPresent` called with `(key, value, newConfig.lockAtMostFor)`.
- `extend` invalidates the original lock: call `extend` then `unlock` on the original → `AbstractSimpleLock` throws `LockException`.

### Step 10: Verify redis-core end-to-end

```bash
cd packages/redis-core
pnpm typecheck && pnpm test && pnpm build
```

### Step 11: Initialize redis (node-redis) package structure

```
packages/redis/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/redis",
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
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*", "@tslock/redis-core": "workspace:*", "redis": "^4.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false }, "@tslock/redis-core": { "optional": false } },
  "devDependencies": { "redis": "^4.0.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0", "typescript": "^5.5.0" }
}
```

### Step 12: Implement NodeRedisTemplate

**File:** `src/node-redis-template.ts`

- `import type { RedisClientType } from 'redis'`
- `class NodeRedisTemplate implements RedisTemplate`:
  - `constructor(private readonly client: RedisClientType) {}`
  - `async setIfAbsent(key, value, expireMillis): Promise<boolean>`:
    - `const result = await this.client.set(key, value, { PX: expireMillis, NX });`
    - Return `result === 'OK'`.
  - `async setIfPresent(key, value, expireMillis): Promise<boolean>`:
    - `const result = await this.client.set(key, value, { PX: expireMillis, XX });`
    - Return `result === 'OK'`.
  - `async eval(script, keys, args): Promise<unknown>`:
    - `return await this.client.eval(script, { keys, arguments: args });`
    - Note: `node-redis` v4's `eval` signature is `client.eval(script, { keys, arguments })`. Verify the exact shape against the installed version; `arguments` may be named `args` in some v4 minors. **Decision:** verify at implementation time; pin v4 in peer deps.
  - `async delete(key): Promise<void>`:
    - `await this.client.del(key);` (discard the count)
  - `async get(key): Promise<string | null>`:
    - `return await this.client.get(key);`

### Step 13: Implement NodeRedisLockProvider

**File:** `src/node-redis-lock-provider.ts`

- `import type { RedisClientType } from 'redis'`
- `import { InternalRedisLockProvider, RedisLockProviderConfig } from '@tslock/redis-core'`
- `class NodeRedisLockProvider implements ExtensibleLockProvider`:
  - `private readonly delegate: InternalRedisLockProvider`
  - `constructor(client: RedisClientType, config?: RedisLockProviderConfig)`:
    - `const template = new NodeRedisTemplate(client);`
    - `this.delegate = new InternalRedisLockProvider(template, config);`
  - `async lock(config)` → `return await this.delegate.lock(config)`

### Step 14: Wire redis index.ts

**File:** `src/index.ts`

Export:
- `NodeRedisLockProvider`
- `NodeRedisTemplate`
- Re-export `RedisLockProviderConfig`, `RedisTemplate` from `@tslock/redis-core`

### Step 15: Write redis unit tests (mocked node-redis client)

**File:** `__tests__/node-redis-template.test.ts`

Mock the `redis` client: `const client = { set: vi.fn(), eval: vi.fn(), del: vi.fn(), get: vi.fn() } as unknown as RedisClientType;`.

- `setIfAbsent`:
  - `client.set` returns `'OK'` → `true`. Assert call args `(key, value, { PX: expireMillis, NX })`.
  - `client.set` returns `null` → `false`.
- `setIfPresent`:
  - `client.set` returns `'OK'` → `true`. Assert call args `(key, value, { PX: expireMillis, XX })`.
  - `client.set` returns `null` → `false`.
- `eval`: assert `client.eval` called with `(script, { keys, arguments: args })`.
- `delete`: assert `client.del` called with `key`.
- `get`: returns the string or `null`.

### Step 16: Write redis integration tests (testcontainers Redis)

**File:** `__tests__/integration/node-redis.integration.test.ts`

- Use `testcontainers` Redis image:
  ```typescript
  import { RedisContainer } from '@testcontainers/redis';
  const container = await new RedisContainer('redis:7').start();
  const client = createClient({ url: container.getUrl() });
  await client.connect();
  ```
- `beforeAll`: start container, create + connect client, `provider = new NodeRedisLockProvider(client, { keyPrefix: 'tslock-test', env: 'default' })`.
- `afterAll`: disconnect client, stop container.
- `beforeEach`: `await client.flushDb()`, `ClockProvider.resetClock()`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })` and `extensibleLockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.

### Step 17: Verify redis package end-to-end

```bash
cd packages/redis
pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
```

### Step 18: Initialize redis-ioredis package structure

```
packages/redis-ioredis/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/redis-ioredis",
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
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*", "@tslock/redis-core": "workspace:*", "ioredis": "^5.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false }, "@tslock/redis-core": { "optional": false } },
  "devDependencies": { "ioredis": "^5.0.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0", "typescript": "^5.5.0" }
}
```

### Step 19: Implement IoRedisTemplate

**File:** `src/io-redis-template.ts`

- `import type Redis, { Cluster } from 'ioredis'`
- `class IoRedisTemplate implements RedisTemplate`:
  - `constructor(private readonly client: Redis | Cluster) {}`
  - `async setIfAbsent(key, value, expireMillis): Promise<boolean>`:
    - `const result = await this.client.set(key, value, 'PX', expireMillis, 'NX');`
    - Return `result === 'OK'`.
  - `async setIfPresent(key, value, expireMillis): Promise<boolean>`:
    - `const result = await this.client.set(key, value, 'PX', expireMillis, 'XX');`
    - Return `result === 'OK'`.
  - `async eval(script, keys, args): Promise<unknown>`:
    - Compute `const sha1 = crypto.createHash('sha1').update(script).digest('hex');`
    - `try { return await this.client.evalsha(sha1, keys.length, ...keys, ...args); }`
    - `catch (e) { if (isNoScriptError(e)) { return await this.client.eval(script, keys.length, ...keys, ...args); } throw e; }`
    - Helper `isNoScriptError(e)`: `e?.name === 'ReplyError' && /NOSCRIPT/.test(e?.message)` (ioredis surfaces `NOSCRIPT` as a `ReplyError`).
  - `async delete(key): Promise<void>`:
    - `await this.client.del(key);`
  - `async get(key): Promise<string | null>`:
    - `return await this.client.get(key);`

**Note on `eval`/`evalsha` arity:** `ioredis`'s `evalsha(sha, numkeys, ...keysAndArgs)` and `eval(script, numkeys, ...keysAndArgs)` take the key count as the second arg, then spread keys + args. Verify the exact signature against the installed `ioredis` v5.

### Step 20: Implement IoRedisLockProvider

**File:** `src/io-redis-lock-provider.ts`

- `import type Redis, { Cluster } from 'ioredis'`
- `import { InternalRedisLockProvider, RedisLockProviderConfig } from '@tslock/redis-core'`
- `class IoRedisLockProvider implements ExtensibleLockProvider`:
  - `private readonly delegate: InternalRedisLockProvider`
  - `constructor(client: Redis | Cluster, config?: RedisLockProviderConfig)`:
    - `const template = new IoRedisTemplate(client);`
    - `this.delegate = new InternalRedisLockProvider(template, config);`
  - `async lock(config)` → `return await this.delegate.lock(config)`

### Step 21: Wire redis-ioredis index.ts

**File:** `src/index.ts`

Export:
- `IoRedisLockProvider`
- `IoRedisTemplate`
- Re-export `RedisLockProviderConfig`, `RedisTemplate` from `@tslock/redis-core`

### Step 22: Write redis-ioredis unit tests (mocked ioredis client)

**File:** `__tests__/io-redis-template.test.ts`

Mock the `ioredis` client: `const client = { set: vi.fn(), evalsha: vi.fn(), eval: vi.fn(), del: vi.fn(), get: vi.fn() } as unknown as Redis;`.

- `setIfAbsent`: assert `client.set` called with `(key, value, 'PX', expireMillis, 'NX')`. Returns `'OK'` → `true`; `null` → `false`.
- `setIfPresent`: assert `client.set` called with `(key, value, 'PX', expireMillis, 'XX')`.
- `eval` (happy path): `evalsha` returns `1` → return `1`. Assert `evalsha` called with `(sha1, 1, key, ...args)`.
- `eval` (NOSCRIPT fallback): `evalsha` rejects with `{ name: 'ReplyError', message: 'NOSCRIPT No matching script. Please use EVAL.' }` → `eval` called with `(script, 1, key, ...args)` → return its result.
- `eval` (other error): `evalsha` rejects with a non-NOSCRIPT error → propagates, `eval` NOT called.
- `delete`: assert `client.del` called with `key`.
- `get`: returns the string or `null`.

### Step 23: Write redis-ioredis integration tests (testcontainers Redis)

**File:** `__tests__/integration/io-redis.integration.test.ts`

- Use `testcontainers` Redis image (same image, different client):
  ```typescript
  import { RedisContainer } from '@testcontainers/redis';
  const container = await new RedisContainer('redis:7').start();
  const client = new Redis(container.getUrl());
  ```
- `beforeAll`: start container, `client = new Redis(container.getUrl())`, `provider = new IoRedisLockProvider(client, { keyPrefix: 'tslock-test', env: 'default' })`.
- `afterAll`: `await client.quit()`, stop container.
- `beforeEach`: `await client.flushdb()`, `ClockProvider.resetClock()`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })` and `extensibleLockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.
- **Optional:** add a `Cluster` integration test using a second Redis container or a cluster-mode image. If `@testcontainers/redis` does not support cluster mode easily, skip the cluster integration test and rely on unit tests + manual verification for the `Cluster` path. Document this.

### Step 24: Verify redis-ioredis package end-to-end

```bash
cd packages/redis-ioredis
pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
```

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `node-redis` v4 `eval` signature differs across minors (`{ keys, arguments }` vs `{ keys, args }`) | Verify against the installed `redis@^4.0.0`. The `arguments` field is the documented shape in v4.6+. Add a unit test asserting the exact call shape; if it drifts, update the adapter. Pin `redis: "^4.0.0"` in peer deps. |
| `ioredis` v5 `evalsha`/`eval` arity (`numkeys` as second positional arg) | `ioredis` v5 uses `evalsha(sha, numkeys, ...keysAndArgs)`. Verify with a unit test. The spread `[...keys, ...args]` after `numkeys` is the documented shape. |
| `NOSCRIPT` error detection in `ioredis` | `ioredis` surfaces Redis `NOSCRIPT` as a `ReplyError` whose `message` includes `NOSCRIPT`. The `isNoScriptError` helper checks `e?.name === 'ReplyError' && /NOSCRIPT/.test(e?.message)`. Add a unit test for the fallback path. |
| `ioredis` `Cluster` mode and `EVALSHA` | In cluster mode, `EVALSHA` works as long as all keys hash to the same slot. Lock keys use a single key (`KEYS[1]`), so they always hit one slot. No cross-slot concern. Document this. |
| `node-redis` `SET` options shape (`{ PX, NX }` vs positional args) | v4 uses the options-object shape `client.set(key, value, { PX, NX })`. Verify with a unit test asserting the options object is passed. |
| `crypto.randomUUID()` availability | Available since Node 14.17 (stable in Node 16+). No concern for Node 22+. Use `import { randomUUID } from 'node:crypto'`. |
| `SET NX PX` atomicity | Redis `SET` with `NX` and `PX` is a single atomic command (documented). No race between `SETNX` and `PEXPIRE`. No mitigation needed. |
| `lockAtLeastFor` unlock does not verify ownership | The `lockAtLeastFor > 0` branch of `doUnlock` uses `SET key value XX PX lockAtLeastFor` without a Lua ownership check. If the lock expired and another instance acquired it (with a different value), the `XX` with our `value` would still set the TTL. ShedLock accepts this (the holder calls `unlock` well within `lockAtMostFor`). TSLock matches ShedLock. Document the caveat in the README. A stricter Lua-based path (`GET`-then-`PEXPIRE`) is possible but diverges. |
| `safeUpdate = false` is unsafe but supported | Document that `safeUpdate: false` skips ownership checks and is only safe when the lock name is unique per holder (no concurrent takeover). Default `true`. |
| Redis `PX` accepts millis (integer) | `lockAtMostFor` and `lockAtLeastFor` are integer millis from `parseDuration`. `PX` expects integer millis. If a user passes a sub-millisecond duration (not possible with `parseDuration` — minimum unit is `ms`), round up. No concern. |
| Redis key prefix collisions across envs | The `env` discriminator in the key (`job-lock:default:my-task`) prevents collisions. Default `env = 'default'`. Users with multiple environments sharing a Redis instance set distinct `env` values. Document. |
| `@testcontainers/redis` availability | Verify a `testcontainers` Redis module exists. If not, use `GenericContainer` with `redis:7`, expose port `6379`, and build the client from the mapped URL. Both `redis` and `ioredis` accept a `redis://host:port` URL. |
| Cluster integration test complexity | If a cluster testcontainer is hard to set up, skip the cluster integration test and rely on unit tests for the `Cluster` path. The `IoRedisTemplate` methods are identical for `Redis` and `Cluster`; only the client type differs. Document the gap. |

## Estimation

~15 source files total (5 in redis-core, 2 in each adapter, plus index files), ~500-700 lines of implementation + ~600-800 lines of tests. One focused session with Docker.

## Order of Implementation

1. `redis-core` package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `constants.ts` (`DEFAULT_KEY_PREFIX`, `ENV_DEFAULT`)
3. `redis-lua-scripts.ts` (`DEL_LUA_SCRIPT`, `UPD_LUA_SCRIPT`)
4. `redis-template.ts` (`RedisTemplate` interface)
5. `redis-lock.ts` (`RedisLock` — `doUnlock` + `doExtend`)
6. `internal-redis-lock-provider.ts` (`InternalRedisLockProvider` + `RedisLockProviderConfig`)
7. `redis-core` `index.ts` exports
8. `redis-core` unit tests (mocked `RedisTemplate`)
9. Verify `redis-core` end-to-end
10. `redis` package scaffolding
11. `node-redis-template.ts` (`NodeRedisTemplate`)
12. `node-redis-lock-provider.ts` (`NodeRedisLockProvider`)
13. `redis` `index.ts` exports
14. `redis` unit tests (mocked `redis` client)
15. `redis` integration tests (testcontainers Redis)
16. Verify `redis` end-to-end
17. `redis-ioredis` package scaffolding
18. `io-redis-template.ts` (`IoRedisTemplate` — includes `EVALSHA`-with-`EVAL`-fallback)
19. `io-redis-lock-provider.ts` (`IoRedisLockProvider`)
20. `redis-ioredis` `index.ts` exports
21. `redis-ioredis` unit tests (mocked `ioredis` client — include NOSCRIPT fallback)
22. `redis-ioredis` integration tests (testcontainers Redis)
23. Verify `redis-ioredis` end-to-end
