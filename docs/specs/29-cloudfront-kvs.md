# Spec: @tslock/cloudfront-kvs

## Overview

The `@tslock/cloudfront-kvs` package provides a **direct** `ExtensibleLockProvider` backed by Amazon CloudFront KeyValueStore via `@aws-sdk/client-cloudfront-keyvaluestore`. It is **not** Redis-compatible. Locks are stored as JSON values under keyed entries; writes use store-wide ETag optimistic concurrency (`IfMatch` from `DescribeKeyValueStore`). CloudFront Functions may **read** the same store at the edge; this provider issues **control-plane** writes from Node (or any AWS SDK client).

**Status:** Accepted for implementation from issue #47.

## Problem

Teams that already use CloudFront KeyValueStore for edge config want the same store for at-most-once scheduled-task locks without adopting Redis/DynamoDB. There is no ShedLock equivalent; TSLock adds this as a first-party edge-oriented provider.

## Goals

- Publish `@tslock/cloudfront-kvs` with dual ESM+CJS, peer `@tslock/core` + `@aws-sdk/client-cloudfront-keyvaluestore`.
- Acquire / skip / unlock / extend with ownership (`lockedBy`) and time-based expiry encoded in the value.
- Treat `ConflictException` (stale store ETag) as retryable contention; after retries, return lock-not-acquired (`undefined` / no-op unlock) rather than throwing.
- Document quotas, Functions-read vs control-plane-write, and that ElastiCache/MemoryDB/Valkey use `@tslock/redis` instead.
- Unit tests with a mocked client; shared contract tests behind an opt-in AWS flag when credentials + a KVS ARN are available.

## Non-goals

- Treating CloudFront KVS as Redis (`SET NX PX`) or sharing `@tslock/redis-core`.
- Writing from CloudFront Functions (Functions are read-only for KVS).
- Creating or managing the KeyValueStore resource (caller provisions via console/IaC).
- Apache Ignite.
- Cloudflare Workers KV / Durable Objects (separate package).

## Architecture fit

| Field | Value |
|---|---|
| **Category** | **B — Direct `LockProvider`** (custom ETag CAS; does not fit clean `StorageAccessor` insert-or-update without store-wide ETag retries) |
| **Package** | `@tslock/cloudfront-kvs` |
| **Peers** | `@tslock/core`, `@aws-sdk/client-cloudfront-keyvaluestore` |
| **Node.js** | >= 22 |

```
@tslock/core
  └── @tslock/cloudfront-kvs
        peer: @aws-sdk/client-cloudfront-keyvaluestore
```

## Public API

### Configuration

```typescript
interface CloudFrontKvsLockProviderOptions {
  client: CloudFrontKeyValueStoreClient; // required — caller owns region/credentials (SigV4A)
  kvsArn: string;                        // required — KeyValueStore ARN
  keyPrefix?: string;                    // default 'tslock/'
  maxEtagRetries?: number;               // default 3 — ConflictException retries on store ETag races
}
```

Validation throws `LockException` when:

- `client` is missing.
- `kvsArn` is missing or empty.
- `keyPrefix` contains control characters or would make keys exceed 512 bytes for a 1-char lock name (document; validate prefix length <= 256).
- `maxEtagRetries` is present and not an integer >= 1.

`resolveCloudFrontKvsConfiguration(input)` merges defaults and returns a frozen object.

### Provider

```typescript
class CloudFrontKvsLockProvider implements ExtensibleLockProvider {
  constructor(options: CloudFrontKvsLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

function createCloudFrontKvsLockProvider(
  options: CloudFrontKvsLockProviderOptions,
): CloudFrontKvsLockProvider;
```

### Lock

```typescript
class CloudFrontKvsLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

### Value format

UTF-8 JSON string (fits in the 1 KB value quota):

```json
{
  "lockUntil": "<ISO-8601 millis>",
  "lockedAt": "<ISO-8601 millis>",
  "lockedBy": "<hostname>"
}
```

Use `Utils.toIsoString` for timestamps and `Utils.getHostname()` for `lockedBy`.

Storage key: `${keyPrefix}${lockName}` (must be 1–512 bytes).

## Behavior

### Store-wide ETag

`PutKey` / `DeleteKey` / `UpdateKeys` require `IfMatch` equal to the **store** ETag from the **KeyValueStore** `DescribeKeyValueStore` API (not the CloudFront distribution `DescribeKeyValueStore`). Concurrent writes to **any** key in the store invalidate the ETag. The provider:

1. `DescribeKeyValueStore` → `ETag`.
2. `GetKey` for the lock key (`ResourceNotFoundException` → absent).
3. Decide acquire / skip / unlock / extend from the value.
4. `PutKey` (or `DeleteKey` when unlocking with no `lockAtLeastFor` remaining and we choose delete — prefer overwrite of `lockUntil` to `unlockTime` for parity with DynamoDB/S3).
5. On `ConflictException`, retry from step 1 up to `maxEtagRetries`. Exhaustion → lock not acquired / unlock no-op / extend returns `undefined`.

### lock(config)

- If key absent or `lockUntil <= now`: put new ownership value with `IfMatch`; success → `CloudFrontKvsLock`.
- If key present and `lockUntil > now`: return `undefined` (do not write).
- Storage / auth / validation errors throw.
- Corrupted JSON / missing fields throw `LockException`.

### unlock

- Load key; missing → no-op.
- Overwrite value setting `lockUntil` to `unlockTime(config)`, preserving `lockedAt` / `lockedBy` when present (S3/DynamoDB pattern).
- ETag conflict retries; exhaustion → no-op (best effort).

### extend

- Load key; require `lockedBy === hostname` and `lockUntil > now`; else return `undefined`.
- Put updated `lockUntil = lockAtMostUntil(newConfig)`.
- Success → new `CloudFrontKvsLock`; conflict exhaustion → `undefined`.

## Edge limits (must document in README)

| Limit | Value |
|---|---|
| Max store size | 5 MB |
| Max key size | 512 bytes |
| Max value size | 1 KB |
| Batch update | 50 keys or 3 MB per `UpdateKeys` |
| Functions access | **Read-only** via CloudFront Functions KVS handle |
| Control-plane writes | This provider (`PutKey` / `DescribeKeyValueStore` / `GetKey`) |
| Concurrency | Store-wide ETag — high cross-key write contention under load |

**Suitability:** Control-plane / low-frequency scheduled locks, not hot per-request edge locking. Propagation to Functions is eventually consistent with CloudFront’s KVS publish model; do not assume Functions see writes immediately.

## Redis-compat clarification (docs only)

Amazon ElastiCache (Redis/Valkey) and MemoryDB are Redis-protocol compatible → use `@tslock/redis` / `@tslock/redis-ioredis`. **CloudFront KeyValueStore is not in that bucket.**

## Error taxonomy

| Condition | Result |
|---|---|
| Lock held | `undefined` |
| Stale ETag after retries | `undefined` / unlock no-op |
| `ResourceNotFoundException` on GetKey during acquire | treat as absent |
| `ResourceNotFoundException` on Describe (store missing) | throw |
| Auth / network / `ValidationException` / quota | throw |
| Corrupt value | throw `LockException` |

## Tests

- **Unit:** mock `client.send` for Describe / GetKey / PutKey; cover acquire, skip, expired re-acquire, conflict retry success/fail, unlock, extend ownership rejection, corrupt value.
- **Integration (opt-in):** `TSLOCK_CLOUDFRONT_KVS_INTEGRATION=1` + `CLOUDFRONT_KVS_ARN` (+ AWS credentials). Run `lockProviderIntegrationTests` + `extensibleLockProviderIntegrationTests` + `fuzzTests` when feasible. Skip cleanly when unset.
- Document that LocalStack support is best-effort / may be unavailable for this API.

## Documentation

- Package README: install, usage, limits table, Functions vs control plane, Valkey/redis-compat pointer.
- Root README + `docs/00-vision.md` matrix rows.
- Changeset (minor for new package).

## Assumptions

- Caller configures `CloudFrontKeyValueStoreClient` with SigV4A support as required by the service.
- Hostname uniqueness matches other TSLock providers for ownership.
- Unlock always overwrites `lockUntil` (does not delete the key) so Functions readers see an expired lock rather than a missing key, unless we later opt into delete — **decision: overwrite only**.

## Unresolved / deferred

- Workers KV and Ignite out of scope.
- No automatic multi-store sharding for ETag contention (callers may use multiple KVS ARNs if needed).
