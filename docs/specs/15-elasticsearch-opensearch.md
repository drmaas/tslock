# Spec: @tslock/elasticsearch + @tslock/opensearch

## Overview

The `@tslock/elasticsearch` and `@tslock/opensearch` packages provide DIRECT `LockProvider` implementations backed by Elasticsearch (v8+) and OpenSearch respectively. They share the **same locking mechanism** — a Painless script executed via the `update` API with `upsert` + `refresh: 'wait_for'` — and differ only in the driver import. Both packages are described in this single spec because their semantics are identical.

The script compares the stored `lockUntil` against `params.now`; if the lock has expired (or the doc does not exist, handled by the `upsert`), it writes the new lock values. Otherwise the script sets `ctx.op = 'none'` (a no-op update), which the driver reports as a `noop` result. The `upsert` body handles the very first lock attempt on a non-existent document. Field names are configurable (DEFAULT camelCase or SNAKE_CASE) so users can match their existing index mapping conventions without reindexing.

## Package

| Field | @tslock/elasticsearch | @tslock/opensearch |
|---|---|---|
| **Name** | `@tslock/elasticsearch` | `@tslock/opensearch` |
| **Driver** | `@elastic/elasticsearch` (v8+) — peer | `@opensearch-project/opensearch` — peer |
| **Dependencies** | `@tslock/core` (peer) | `@tslock/core` (peer) |
| **Node.js** | >= 20 | >= 20 |
| **Module format** | Dual ESM + CJS | Dual ESM + CJS |
| **Build** | tsup | tsup |

## Public API

### 1. ElasticsearchLockProvider / OpenSearchLockProvider

```typescript
class ElasticsearchLockProvider implements ExtensibleLockProvider {
  constructor(client: Client, options?: ElasticsearchLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

class OpenSearchLockProvider implements ExtensibleLockProvider {
  constructor(client: Client, options?: OpenSearchLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Where `Client` is `@elastic/elasticsearch`'s `Client` for ES, and `@opensearch-project/opensearch`'s `Client` for OpenSearch. The options shape is identical between the two packages.

### 2. Options

```typescript
interface ElasticsearchLockProviderOptions {
  index?: string;                          // default: 'shedlock'
  fieldNames?: ElasticsearchFieldNames;    // default: FieldNames.DEFAULT (camelCase)
}

interface OpenSearchLockProviderOptions {
  index?: string;
  fieldNames?: OpenSearchFieldNames;
}

interface ElasticsearchFieldNames {  // identical shape for OpenSearchFieldNames
  lockUntil: string;
  lockedAt: string;
  lockedBy: string;
}

declare const FieldNames: {
  DEFAULT: ElasticsearchFieldNames;       // { lockUntil, lockedAt, lockedBy }
  SNAKE_CASE: ElasticsearchFieldNames;   // { lock_until, locked_at, locked_by }
};
```

Field-name casing lets users match their existing index mapping conventions without reindexing. Field names are passed as `params.lockUntilField` / `params.lockedAtField` / `params.lockedByField` in the Painless script so the script source itself is constant (avoids per-name script recompilation).

### 3. Lock classes

```typescript
class ElasticsearchLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

class OpenSearchLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

### 4. Accessor (internal, per package)

```typescript
class ElasticsearchAccessor {
  constructor(client: Client, index: string, fieldNames: ElasticsearchFieldNames);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  extend(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}

class OpenSearchAccessor {
  constructor(client: Client, index: string, fieldNames: OpenSearchFieldNames);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  extend(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}
```

**Note on code duplication:** The two accessors are duplicated intentionally. The driver client types (`@elastic/elasticsearch` vs `@opensearch-project/opensearch`) are incompatible at the TypeScript level; a shared support package would force `any` casts and lose type safety. The duplication is ~80 lines per package and trivial to keep in sync (the Painless script and locking mechanism are stable; ShedLock has not changed this script in years).

## Locking Mechanism

Both packages use the same Painless script. The driver `update` call sends:
- `id`: the lock name
- `index`: configured index (default `shedlock`)
- `refresh: 'wait_for'` — force the update to be visible to subsequent reads before returning. This is critical for the `shouldSkipIfLocked` test (a second lock attempt immediately after the first must see the new doc).
- `body.script.source`: Painless snippet (below)
- `body.script.params`: `{ now, lockUntil, lockedAt, lockedBy, lockUntilField, lockedAtField, lockedByField }` (ISO-8601 strings + field-name strings)
- `body.upsert`: the document to insert when the doc does not exist (first lock)

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const isoNow = Utils.toIsoString(now);
  const isoLockUntil = Utils.toIsoString(lockAtMostUntil(config));
  const isoLockedAt = isoNow;
  const hostname = Utils.getHostname();

  try {
    const response = await this.client.update({
      id: config.name,
      index: this.index,
      refresh: 'wait_for',
      body: {
        script: {
          source: `
            if (ctx._source[params.lockUntilField] <= params.now) {
              ctx._source[params.lockUntilField] = params.lockUntil;
              ctx._source[params.lockedAtField] = params.lockedAt;
              ctx._source[params.lockedByField] = params.lockedBy;
            } else {
              ctx.op = 'none';
            }
          `,
          params: {
            now: isoNow,
            lockUntil: isoLockUntil,
            lockedAt: isoLockedAt,
            lockedBy: hostname,
            lockUntilField: this.fieldNames.lockUntil,
            lockedAtField: this.fieldNames.lockedAt,
            lockedByField: this.fieldNames.lockedBy,
          },
        },
        upsert: {
          [this.fieldNames.lockUntil]: isoLockUntil,
          [this.fieldNames.lockedAt]: isoLockedAt,
          [this.fieldNames.lockedBy]: hostname,
        },
      },
    });

    if (response.result === 'noop') return undefined;
    return new ElasticsearchLock(config, this);
  } catch (e) {
    if (isConflictError(e)) return undefined;  // 409 version conflict
    throw e;
  }
}
```

Semantics:
- Doc exists and `lockUntil <= now` → script updates fields → `result: 'updated'` → lock acquired.
- Doc exists and `lockUntil > now` → script sets `ctx.op = 'none'` → `result: 'noop'` → lock not acquired → `undefined`.
- Doc does not exist → `upsert` body creates the doc with the new lock values → `result: 'created'` → lock acquired.
- Two concurrent attempts on a non-existent doc: Elasticsearch uses optimistic concurrency control; one succeeds, the other gets a 409 conflict → caught → `undefined`.

### extend(config)

ShedLock's base ES provider does not implement extend, but it is straightforward to add (same script + condition pattern). TSLock implements it so `KeepAliveLockProvider` can wrap these providers.

```typescript
async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const isoNow = Utils.toIsoString(now);
  const isoNewLockUntil = Utils.toIsoString(lockAtMostUntil(config));
  const hostname = Utils.getHostname();

  try {
    const response = await this.client.update({
      id: config.name,
      index: this.index,
      refresh: 'wait_for',
      body: {
        script: {
          source: `
            if (ctx._source[params.lockedByField] == params.lockedBy && ctx._source[params.lockUntilField] > params.now) {
              ctx._source[params.lockUntilField] = params.lockUntil;
            } else {
              ctx.op = 'none';
            }
          `,
          params: {
            now: isoNow,
            lockUntil: isoNewLockUntil,
            lockedBy: hostname,
            lockUntilField: this.fieldNames.lockUntil,
            lockedByField: this.fieldNames.lockedBy,
          },
        },
      },
    });

    if (response.result === 'noop') return undefined;
    return new ElasticsearchLock(config, this);
  } catch (e) {
    if (isConflictError(e)) return undefined;
    throw e;
  }
}
```

Only the original holder (`lockedBy == hostname`) can extend, and only while the lock is still valid (`lockUntil > now`). No `upsert` for extend — extending a non-existent lock returns `noop` (the script's `else` branch runs against a missing `_source`, producing `noop`, or the driver returns `not_found` which is also treated as failure).

### unlock(config)

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const isoUnlock = Utils.toIsoString(unlockTime(config));

  try {
    await this.client.update({
      id: config.name,
      index: this.index,
      refresh: 'wait_for',
      body: {
        script: {
          source: `ctx._source[params.lockUntilField] = params.unlockTime`,
          params: {
            unlockTime: isoUnlock,
            lockUntilField: this.fieldNames.lockUntil,
          },
        },
      },
    });
  } catch (e) {
    if (isNotFoundError(e)) return;  // doc does not exist — benign no-op
    throw e;
  }
}
```

No condition — unlock is unconditional. If the doc does not exist, the `update` call returns a `not_found` result; the provider swallows it (the lock is already gone). `unlockTime(config)` = `max(now, lockAtLeastUntil(config))` honors `lockAtLeastFor`.

## Driver Differences

| Aspect | `@elastic/elasticsearch` (v8+) | `@opensearch-project/opensearch` |
|---|---|---|
| Client import | `import { Client } from '@elastic/elasticsearch'` | `import { Client } from '@opensearch-project/opensearch'` |
| Request shape | `client.update({ id, index, refresh, body })` | Same — `client.update({ id, index, refresh, body })` |
| 409 conflict error | `ResponseError` with `meta.statusCode === 409` | `ResponseError` with `meta.statusCode === 409` |
| 404 not-found error | `ResponseError` with `meta.statusCode === 404`, OR `result: 'not_found'` in the response body | Same |
| `result` field | `response.result` ∈ `'created'`, `'updated'`, `'noop'`, `'not_found'` | Same |
| Auth / TLS | Configured on the `Client` constructor by the user | Same |

The `isConflictError(e)` helper inspects `e.meta?.statusCode === 409 || e.statusCode === 409` (the two drivers expose slightly different error shapes; the helper normalizes them). The `isNotFoundError(e)` helper similarly checks for `404` or `result === 'not_found'`.

## File Structure

Each package is structurally identical; only the driver import and class names differ.

```
packages/elasticsearch/                       packages/opensearch/
├── src/                                      ├── src/
│   ├── index.ts                              │   ├── index.ts
│   ├── elasticsearch-lock-provider.ts        │   ├── opensearch-lock-provider.ts
│   ├── elasticsearch-lock.ts                 │   ├── opensearch-lock.ts
│   ├── elasticsearch-accessor.ts             │   ├── opensearch-accessor.ts
│   └── field-names.ts                         │   └── field-names.ts
├── __tests__/                                ├── __tests__/
│   ├── elasticsearch-lock-provider.test.ts    │   ├── opensearch-lock-provider.test.ts
│   └── integration/                          │   └── integration/
│       ├── elasticsearch.integration.test.ts  │       ├── opensearch.integration.test.ts
│       └── testcontainer setup                │       └── testcontainer setup
├── package.json                              ├── package.json
├── tsconfig.json                             ├── tsconfig.json
└── tsup.config.ts                            └── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | script sets `ctx.op = 'none'` → `result: 'noop'` → `undefined` |
| First lock on a new doc | `upsert` creates the doc → `result: 'created'` → lock acquired |
| Concurrent upserts on a new doc | 409 conflict → caught → `undefined` |
| Connection error | Propagate driver error |
| Index does not exist | `resource_not_found_error` (ES) / equivalent (OS) propagates — user must pre-create the index |
| `extend()` on expired lock | script noop (`lockUntil > now` fails) → `undefined` |
| `extend()` by a different holder | script noop (`lockedBy == hostname` fails) → `undefined` |
| `extend()` on a non-existent doc | `result: 'not_found'` (no `upsert` for extend) → treated as `undefined` |
| `unlock()` on a non-existent doc | `result: 'not_found'` → swallowed, no error |
| `refresh: 'wait_for'` times out | Propagate (indicates an overloaded cluster — the caller should retry) |

## Dependencies

### @tslock/elasticsearch
- **Peer**: `@tslock/core`, `@elastic/elasticsearch` (`^8.0.0`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`

### @tslock/opensearch
- **Peer**: `@tslock/core`, `@opensearch-project/opensearch` (`^2.0.0`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`

## Exports

Each package exports from its `src/index.ts`:
- `ElasticsearchLockProvider` / `OpenSearchLockProvider`
- `ElasticsearchLockProviderOptions` / `OpenSearchLockProviderOptions`
- `ElasticsearchFieldNames` / `OpenSearchFieldNames`
- `FieldNames` constant (`DEFAULT`, `SNAKE_CASE`)

`ElasticsearchAccessor`, `OpenSearchAccessor`, `ElasticsearchLock`, and `OpenSearchLock` are not exported as public API.

## Non-Goals (for these packages)

- No index creation / mapping management: the user pre-creates the index with whatever mapping they prefer. The lock fields are stored as ISO-8601 strings (or `date` type if the user maps them as such — the script's `<=` comparison works on both, since ES coerces consistently within a single field mapping).
- No ILM / snapshot integration.
- No multi-index / alias support: a single index is configured. For alias-backed indexes, point the client at the alias; the `update` API routes to the underlying concrete index correctly.
- No security configuration: TLS, auth, and API keys are configured on the driver `Client` by the user.
- No `wait_for_active_shards` tuning beyond the driver default. `refresh: 'wait_for'` is the only freshness knob the provider sets.
- No shared support package: the two drivers have incompatible TypeScript types, so the accessors are duplicated intentionally to preserve type safety. A shared module would require `any` casts.
