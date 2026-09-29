# Spec: @tslock/cloudflare-do

## Overview

The `@tslock/cloudflare-do` package provides an **edge-coordinated** `ExtensibleLockProvider` backed by Cloudflare Durable Objects. A Durable Object class persists lock records in strongly consistent DO storage; a client `LockProvider` talks to that object over `fetch` (Worker stub or HTTP). **Workers KV is not implemented** in this package — eventual consistency makes it unsuitable for lock acquire without extra coordination; it is an explicit follow-up.

**Status:** Accepted for implementation from issue #47 (Durable Objects first; KV deferred).

## Problem

Cloudflare Workers / Pages applications need at-most-once scheduled or cron-triggered work without Redis. Durable Objects serialize requests per object and provide strongly consistent storage — a natural fit for distributed locks. Workers KV alone cannot safely provide acquire CAS.

## Goals

- Publish `@tslock/cloudflare-do` with dual ESM+CJS, peer `@tslock/core` only for the Node/client surface (no Cloudflare runtime peer required to compile the client).
- Export a deployable `TslockLockDurableObject` (or equivalently named) class implementing the lock protocol over HTTP JSON.
- Export `createCloudflareDoLockProvider` that implements `ExtensibleLockProvider` via an injectable `fetch` adapter keyed by lock name (supports `idFromName` sharding).
- Unit-test the protocol handler with an in-memory storage fake; unit-test the client against a mock fetch.
- Document Workers KV as deferred / not recommended for locks.
- Document Bun: no Bun-only package; DO provider is Cloudflare-runtime + Node client.

## Non-goals

- Shipping a full Wrangler project or Cloudflare account automation.
- Implementing Workers KV as a lock backend in this package.
- CloudFront KeyValueStore (separate package `@tslock/cloudfront-kvs`).
- Apache Ignite.
- Depending on `cloudflare:workers` types at publish time for the **client** entry (DO class may use minimal structural types so the package builds under Node CI without Wrangler).

## Architecture fit

| Field | Value |
|---|---|
| **Category** | **J — Cloudflare Durable Objects** (new specialized category) |
| **Package** | `@tslock/cloudflare-do` |
| **Peers** | `@tslock/core` |
| **Node.js** | >= 22 (client); Workers runtime for the DO class |

```
@tslock/core
  └── @tslock/cloudflare-do
        ├── CloudflareDoLockProvider (client)
        └── TslockLockDurableObject (Worker DO protocol handler)
```

One Durable Object instance **per lock name** (`idFromName(lockName)`) is the recommended deployment so unrelated locks do not serialize on one object.

## Public API

### Protocol (JSON over HTTP)

`POST` body:

```typescript
type LockOp =
  | { op: 'lock'; name: string; lockAtMostFor: number; lockAtLeastFor: number; createdAt: number; lockedBy: string }
  | { op: 'unlock'; name: string; lockAtMostFor: number; lockAtLeastFor: number; createdAt: number; lockedBy: string }
  | { op: 'extend'; name: string; lockAtMostFor: number; lockAtLeastFor: number; createdAt: number; lockedBy: string };
```

Responses:

```typescript
type LockOpResult =
  | { ok: true; acquired?: boolean; extended?: boolean }
  | { ok: false; reason: 'held' | 'not_owner' | 'expired' | 'missing' };
```

- `lock`: `ok: true, acquired: true` or `ok: false, reason: 'held'`.
- `unlock`: `ok: true` (including missing key no-op).
- `extend`: `ok: true, extended: true` or `ok: false` with `not_owner` / `expired` / `missing`.

HTTP 200 for protocol outcomes; HTTP 400 for malformed bodies. Storage failures may be 500.

### Storage record

```typescript
interface DoLockRecord {
  lockUntil: number; // epoch millis
  lockedAt: number;
  lockedBy: string;
}
```

Stored under key `lock:<name>` (or the bare name when the DO is already sharded by name — **decision:** when using per-name DO instances, store under fixed key `'lock'`; when using a single shared DO, store under `lock:${name}`. The exported DO class supports **both**: if request `name` is present, use `lock:${name}` so a single object can host many locks in tests; production docs recommend `idFromName(name)` + still pass `name` for clarity).

### Client

```typescript
interface CloudflareDoFetcher {
  (lockName: string, init: RequestInit): Promise<Response>;
}

interface CloudflareDoLockProviderOptions {
  fetch: CloudflareDoFetcher;
}

class CloudflareDoLockProvider implements ExtensibleLockProvider {
  constructor(options: CloudflareDoLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

function createCloudflareDoLockProvider(
  options: CloudflareDoLockProviderOptions,
): CloudflareDoLockProvider;
```

`lockedBy` uses `Utils.getHostname()`.

### Durable Object handler

Export `handleTslockLockRequest(storage, request, now?: number): Promise<Response>` pure protocol function plus a thin `TslockLockDurableObject` class that delegates to DO storage (`get`/`put`) so unit tests can exercise the handler without the Workers runtime.

```typescript
interface DoLockStorage {
  get(key: string): Promise<DoLockRecord | undefined>;
  put(key: string, value: DoLockRecord): Promise<void>;
}
```

## Behavior

### lock

Inside the DO (serialized):

1. Read record for key.
2. If present and `lockUntil > now` → `{ ok: false, reason: 'held' }`.
3. Else put new record with `lockUntil = createdAt + lockAtMostFor`, `lockedAt = createdAt`, `lockedBy` → `{ ok: true, acquired: true }`.

Client maps `held` → `undefined`; `acquired` → `CloudflareDoLock`.

### unlock

1. Read record; missing → ok.
2. Set `lockUntil = max(now, createdAt + lockAtLeastFor)` (same as `unlockTime` semantics using provided config timestamps) → ok.

Client ignores failures that still return HTTP 200 with ok.

### extend

1. Require record with `lockedBy` match and `lockUntil > now`.
2. Else `{ ok: false, reason: ... }`.
3. Update `lockUntil = createdAt + lockAtMostFor` → `{ ok: true, extended: true }`.

## Workers KV (deferred)

| Option | Verdict |
|---|---|
| Workers KV | **Deferred.** Eventually consistent; no atomic compare-and-swap across regions suitable for ShedLock-style locks. Document in README + vision as follow-up only if a coordination pattern is designed. |
| Durable Objects | **In scope** — strong consistency + input gates. |

## Tests

- Unit: protocol handler with map-backed `DoLockStorage` (acquire, skip, expire, unlock least-for, extend, not owner).
- Unit: client provider with mock `fetch`.
- Integration: optional Wrangler/miniflare later; not required for v1 CI if unit coverage of the protocol is strong. Prefer documenting `TSLOCK_CLOUDFLARE_DO_INTEGRATION` hook for future.

## Documentation

- Package README: Worker binding example (`idFromName`), Node client calling a Worker URL, KV deferred note.
- Root README + vision Category J.
- Changeset minor.

## Assumptions

- Caller deploys the DO class and provides a working `fetch` adapter.
- Clocks remain NTP-synced between clients writing `createdAt` and the DO’s `Date.now()` for expiry checks — **decision:** DO uses its own `Date.now()` for “is held?” comparisons against stored `lockUntil`; clients send `createdAt` / durations used to compute new `lockUntil = createdAt + lockAtMostFor` for parity with TSLock configs. Document clock sync requirement.

## Compatibility

Additive new package. No changes to `@tslock/core` public API.
