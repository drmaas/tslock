# Spec: @tslock/cloudflare-kv

## Overview

`@tslock/cloudflare-kv` is an **advisory / best-effort** `ExtensibleLockProvider` backed by Cloudflare Workers KV. It stores a JSON lock record with an ownership token and sets KV `expirationTtl` as a garbage-collection backstop. It does **not** provide mutual exclusion.

Workers KV is eventually consistent, caches reads (including negative lookups), and has no compare-and-swap or `SET NX`. Two callers can both observe a missing or stale key and both proceed. This package ships anyway for workloads that accept duplicate execution, and it says so in the API, README, and failure-mode guide.

Strong consistency on Cloudflare remains `@tslock/cloudflare-do` (Category J).

**Status:** Accepted for implementation from issue #63.

## Problem

Some Workers apps already have a KV namespace and want a ShedLock-shaped skip-if-held API without provisioning Durable Objects. KV cannot implement that protocol safely. Hiding that fact would be worse than shipping a clearly labeled advisory provider.

## Goals

- Publish `@tslock/cloudflare-kv` (dual ESM+CJS, peer `@tslock/core` only).
- Implement `ExtensibleLockProvider` against a structural `KVNamespace` (`get` / `put` / `delete`).
- Offer an optional REST binding for Node (account id, namespace id, API token) with the same semantics. REST does not add CAS or a stronger consistency claim.
- Ownership tokens for unlock and extend, so a fresh read of someone else's record does not release or renew it.
- Logical lease is `lockUntil` (epoch millis). KV `expirationTtl` is at least 60 seconds and never shorter than the remaining logical lease (rounded up, plus one second).
- Require callers to set `acknowledgeAdvisoryLock: true`.
- Document failure modes: stale reads (two holders), delayed deletes (phantom holds), the 60-second TTL floor, and the one-write-per-second-per-key limit.
- Unit tests plus the shared extensible contract against an in-memory namespace. Failure-mode tests use a `MutableClock` and a fake that can serve stale reads.
- Point strong-consistency users at `@tslock/cloudflare-do`.

## Non-goals

- Mutual exclusion, fencing tokens, or a claim that read-after-write confirmation closes the race.
- Replacing Durable Objects or changing `@tslock/cloudflare-do` behavior (README may link here).
- A Redis-compatible API. KV is not Redis.
- Miniflare / Wrangler in CI. A live binding is not a cheap, deterministic contract target: real KV violates skip-if-held and the one-write-per-second limit. No opt-in integration suite ships in this change.
- `cacheTtl` overrides. The platform default is already 60 seconds and cannot make reads linearizable.

## Architecture fit

| Field | Value |
|---|---|
| **Category** | **K — Cloudflare Workers KV (advisory)** |
| **Package** | `@tslock/cloudflare-kv` |
| **Peers** | `@tslock/core` |
| **Node.js** | >= 22; Workers runtime for a `KVNamespace` binding |

```
@tslock/core
  └── @tslock/cloudflare-kv
        ├── CloudflareKvLockProvider
        └── createCloudflareKvRestNamespace (optional HTTP binding)
```

Category J stays the strongly consistent Durable Objects provider. Category K is a different mechanism and must not be described as a DO substitute.

## Public API

```typescript
interface CloudflareKvPutOptions {
  expiration?: number;
  expirationTtl?: number;
}

interface CloudflareKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: CloudflareKvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareKvLockProviderOptions {
  kv: CloudflareKvNamespace;
  /** Required. Construction throws if this is not exactly true. */
  acknowledgeAdvisoryLock: true;
  /** Default `tslock:`. */
  keyPrefix?: string;
  /**
   * Default true. After put, read once and treat a missing or different token
   * as not acquired. This does not make acquire atomic.
   */
  confirmWrite?: boolean;
}

interface CloudflareKvRestOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Default `https://api.cloudflare.com/client/v4`. */
  apiBase?: string;
}

const CLOUDFLARE_KV_MIN_EXPIRATION_TTL_SECONDS: 60;

function kvExpirationTtlSeconds(lockUntilMs: number, nowMs: number): number;

class CloudflareKvLockProvider implements ExtensibleLockProvider {
  constructor(options: CloudflareKvLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

function createCloudflareKvLockProvider(
  options: CloudflareKvLockProviderOptions,
): CloudflareKvLockProvider;

function createCloudflareKvRestNamespace(options: CloudflareKvRestOptions): CloudflareKvNamespace;
```

`Workers KVNamespace` is structurally compatible (`get` without a type returns `string | null`). The package does not depend on `cloudflare:workers` or `@cloudflare/workers-types`.

JSDoc on `CloudflareKvLockProvider` and `createCloudflareKvLockProvider` states that the provider is best-effort, lists the four failure modes, and names `@tslock/cloudflare-do` as the strong-consistency alternative.

### Storage record

JSON text at `` `${keyPrefix}${name}` ``:

```typescript
interface KvLockRecord {
  lockUntil: number;
  lockedAt: number;
  lockedBy: string;
  token: string;
}
```

- `token` is `crypto.randomUUID()` generated per successful acquire. Extend keeps the same token.
- `lockedBy` is `Utils.getHostname()` and is diagnostic only. Ownership checks use `token`.
- Storage key UTF-8 length must be 1..512 bytes. Longer keys throw `LockException`.

### `kvExpirationTtlSeconds`

```
max(60, floor(max(0, lockUntilMs - nowMs) / 1000) + 1)
```

The +1 second matches `Utils.toTtlSeconds`: KV expiry is a backstop and must not delete the key before logical `lockUntil`. Values below 60 are rejected by KV, so short leases still occupy the key for 60 seconds. Acquire decisions use `lockUntil`, not key presence.

## Behavior

Clock source for “is it held?” is `ClockProvider.now()`. New deadlines use `lockAtMostUntil(config)` and `unlockTime(config)` from core.

### lock

1. `GET` the key. Missing → try to acquire. Present and `lockUntil > now` → return `undefined`. Present and expired → try to acquire.
2. `PUT` a new record and `expirationTtl = kvExpirationTtlSeconds(lockUntil, now)`.
3. If `confirmWrite` (default): `GET` again. Token match → return `CloudflareKvLock`. Missing or different token → return `undefined` and **do not delete** (a delete could remove the winner).
4. If `confirmWrite` is false: return the lock after `PUT` without a second read.

A stale `GET` in step 1 can miss a live holder. Two overlapping acquires can both `PUT` and both observe their own token. Both results are successful acquisitions. That is the documented dual-holder failure.

### unlock

The lock object passes its token.

1. `GET`. Missing or `token` mismatch → return (no write).
2. If `unlockTime(config) <= now` → `DELETE`.
3. Otherwise `PUT` the same token with `lockUntil = unlockTime(config)` and a refreshed `expirationTtl`.

On a fresh read, a late unlock after someone else acquired is a no-op. On a stale read of the caller’s own previous value, `DELETE` / `PUT` are unconditional and can remove or overwrite the newer holder. That is a documented failure, not something the provider can prevent.

### extend

1. `GET`. Missing, token mismatch, or `lockUntil <= now` → `undefined` (no write).
2. `PUT` `lockUntil = lockAtMostUntil(config)`, same token, refreshed `expirationTtl`.
3. Confirm read when `confirmWrite` is true; mismatch → `undefined` without a compensating delete.

### Errors

| Situation | Result |
|---|---|
| Lock held on the read we actually saw | `undefined` |
| Confirm read does not show our token | `undefined` |
| Unlock token mismatch or missing key | resolve `void` |
| Extend token mismatch, missing, or expired | `undefined` |
| `acknowledgeAdvisoryLock !== true` | throw `LockException` before any KV call |
| Invalid prefix, empty REST ids, key longer than 512 bytes | throw `LockException` |
| Malformed JSON or a record missing finite times / token / lockedBy | throw `LockException` |
| KV / HTTP failure, including HTTP 429 (1 write/second/key) | throw (REST non-2xx except GET/DELETE 404 becomes `LockException`) |

GET and DELETE HTTP 404 on the REST binding are “missing”, not errors. REST `PUT` sends `expiration_ttl` when `expirationTtl` is set.

The provider does not catch rate-limit errors and does not client-side throttle. Keep-alive renewals closer than one second (`lockAtMostFor` under about two seconds) can 429.

## Tests

- Resolver rejects a missing namespace, a missing acknowledgement, a bad prefix, and a non-boolean `confirmWrite`.
- `kvExpirationTtlSeconds` is 60 for a 5 second lease and `floor(ms/1000)+1` when that exceeds 60.
- Shared `extensibleLockProviderIntegrationTests` with `timeMode: 'mock'` against a linearizable in-memory namespace (fresh reads). Do **not** register `fuzzTests`: “exactly one of 50” is not a KV guarantee, and a linearizable map still loses if both reads happen before either put.
- Fresh-read ownership: after expiry and a second acquire, the first lock’s `unlock()` does not release the second holder.
- Failure modes, in package tests (not only the in-memory harness):
  - Two PoP caches: a cached miss lets a second acquire succeed while the first holder’s write is invisible → two locks.
  - Cached value after `DELETE` skips the next acquire (phantom hold) until that cache entry is dropped.
  - `MutableClock`: a 5 second logical lease is stored with `expirationTtl >= 60`, and advancing the clock past `lockUntil` allows another acquire while the key still exists.
  - A fake that throws a 429 on a second write inside one second: `unlock()` rejects and does not return success.
  - Stale unlock: a cache that still shows the caller’s token issues `DELETE` and a third acquire can proceed while the newer holder has not unlocked.
- REST binding unit tests with a mock `fetch`: 404 get, put query `expiration_ttl`, delete, and non-2xx `LockException`.

## Documentation

- Package README leads with the advisory warning, KV vs Durable Objects, the four failure modes, binding and REST examples, and the `acknowledgeAdvisoryLock: true` option.
- Root README matrix, caveats, and failure-mode link.
- `docs/00-vision.md` edge row and provider table.
- `docs/01-architecture.md` Category K. Category J no longer says KV is deferred.
- `docs/failure-modes.md` gains the four KV modes and points at the package tests.
- `@tslock/cloudflare-do` README points at this package as advisory and keeps DO as the strong path.
- Changeset: minor for `@tslock/cloudflare-kv`.

## Assumptions

- Callers pass a real `KVNamespace` or the REST binding. This package does not open network connections except through the user-supplied `fetch`.
- `globalThis.crypto.randomUUID()` exists (Node 22 and Workers).
- Process clocks follow the same NTP assumption as the rest of TSLock. KV’s own expiration clock can still drop a key on its 60-second-or-longer TTL independently of `ClockProvider`.
- Same-location read-your-writes is **not** relied on. Cloudflare documents it as usual, not guaranteed.

## Compatibility

Additive package plus documentation. No `@tslock/core` API change. Existing providers are unchanged aside from the Durable Objects README pointer.
