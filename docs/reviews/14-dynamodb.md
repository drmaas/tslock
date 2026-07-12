# Review: @tslock/dynamodb

**Spec:** `docs/specs/14-dynamodb.md`
**Plan:** `docs/plans/14-dynamodb.md`

## Summary

The DynamoDB provider spec describes a DIRECT `LockProvider` using `UpdateItem` + `ConditionExpression`, with ISO-8601 string attributes whose lexicographic ordering matches chronological ordering. `ConditionalCheckFailedException` maps to `undefined`. The design mirrors ShedLock's `DynamoDBLockProvider` and adds extend (which ShedLock's base provider omits) so `KeepAliveLockProvider` can wrap it. The spec is technically sound; the ISO-8601 comparison reasoning is correct and well-argued. A few notes on the `:lockedAt` value playing double duty, partition-key string interpolation hygiene, and a sort-key API limitation that is documented but worth flagging.

## Vision Alignment

Aligned. Framework-agnostic, provider-pluggable, minimal-dependency (`@tslock/core` + `@aws-sdk/client-dynamodb` peer only — notably avoiding `@aws-sdk/util-dynamodb` by using native `{ S: ... }` literals), async-native, type-safe. Uses core abstractions (`ClockProvider.now()`, `Utils.toIsoString()`, `Utils.getHostname()`). No framework/scheduler coupling. The choice to keep the dep surface to just the client package is a strong fit for the "minimal dependencies" principle.

## Architecture Alignment

Correctly specified as a DIRECT `LockProvider` (Category B, per `01-architecture.md` §6.2). DynamoDB's `UpdateItem` + condition expression does not fit the `StorageBasedLockProvider` insert-then-update pattern, so bypassing `StorageAccessor` is correct. `DynamoDBLockProvider implements ExtensibleLockProvider` is correct because extend is implemented (additive over ShedLock's base, which throws). `DynamoDBAccessor` and `DynamoDBLock` are internal (not exported).

Package dependency rule compliance: `@tslock/dynamodb` depends on `@tslock/core` + `@aws-sdk/client-dynamodb` (peer) only. No dependency on other providers or on `@aws-sdk/util-dynamodb`. Good.

## Spec Completeness

Complete. The spec covers: package metadata, public API (`DynamoDBLockProvider`, `DynamoDBLockProviderOptions` with `client?`, `tableName`, `partitionKey?`, `sortKey?`), the `buildKey` helper, lock/extend/unlock with full `UpdateItemCommand` bodies, condition-expression semantics (including the `attribute_not_exists(lockUntil)` OR-short-circuit for new items), the ISO-8601 comparison correctness argument, error-handling table, file structure, dependencies, exports, and non-goals. The sort-key support is documented (for composite-key tables).

One omission: the spec does not specify the attribute types the table must declare. Since all values are `{ S: ... }` (string), the partition key must be a string attribute (`AttributeType: 'S'`). The plan's integration test correctly creates the table with `AttributeType: 'S'`, but the spec should state this requirement for the user's own table provisioning (the spec says "must already exist" but doesn't specify the expected attribute type). Minor.

## Plan Completeness

Complete and thorough. Nine steps: scaffolding → options+validation → `DynamoDBAccessor` (with `buildKey`) → `DynamoDBLock` → `DynamoDBLockProvider` → `index.ts` → unit tests → integration tests (partition-key) → integration tests (composite-key). The two-suite integration approach (partition-key-only AND composite-key) is a strong choice and exercises the `buildKey` helper's both branches.

The unit-test plan asserts the exact `ConditionExpression` strings, `ExpressionAttributeValues` shapes (`{ S: ... }` literals), ISO string formation, and `lockAtLeastFor` honoring. The risk table addresses LocalStack fidelity, SDK import stability, ISO comparison correctness, and the stray-record-on-unlock mitigation.

One gap: the integration test `beforeEach` says "delete all items (or use a unique partition key per test via `uniqueLockName`)." This is hand-wavy — the test-support contract likely requires a clean slate per test. The plan should commit to one approach (e.g., a `Scan` + batch delete, or per-test unique lock names) and document it.

## Technical Correctness

**`lock` ConditionExpression — CORRECT.** `lockUntil <= :lockedAt OR attribute_not_exists(lockUntil)` where `:lockedAt = isoNow`:
- Existing item, expired (`lockUntil <= now`) → first clause true → condition passes → update applied. Correct.
- Existing item, held (`lockUntil > now`) → first clause false, `attribute_not_exists(lockUntil)` false → condition fails → `ConditionalCheckFailedException` → `undefined`. Correct.
- Absent item → `lockUntil <= :lockedAt` false (attribute absent → comparison false), `attribute_not_exists(lockUntil)` true → OR passes → item created. Correct.

This matches ShedLock's DynamoDB condition. The `OR` short-circuit for new items is the correct way to handle DynamoDB's "missing attribute returns false for `<=`" semantics.

**`:lockedAt` double duty — CORRECT but confusing.** `:lockedAt` = `isoNow` is used both as (a) the new value written to the `lockedAt` field (`SET lockedAt = :lockedAt`) AND (b) the comparison bound in the condition (`lockUntil <= :lockedAt`). This is logically correct because both equal `now`, and it saves one `ExpressionAttributeValues` entry. But the name `:lockedAt` for "the current time bound" is misleading — a reader might expect a `:now` placeholder. ShedLock uses `:lockedAt` for the field value and a separate `:now` for the bound, or reuses — both are seen in the wild. Recommend either renaming for clarity OR adding a one-line comment in the implementation that `:lockedAt` intentionally equals `now` and serves both roles.

**`extend` ConditionExpression — CORRECT.** `lockedBy = :lockedBy AND lockUntil > :now` — only the original holder can extend, and only while still valid. Returns `undefined` on condition failure. Correct and a sound addition over ShedLock's base (which throws on extend). The plan documents this divergence.

**`unlock` ConditionExpression — CORRECT.** `attribute_exists(${partitionKey})` guards against creating a stray item when the lock doesn't exist; `ConditionalCheckFailedException` is swallowed. `unlockTime(config) = max(now, lockAtLeastUntil(config))` honors `lockAtLeastFor`. Correct.

**ISO-8601 string comparison — CORRECT.** `Utils.toIsoString` emits fixed-width, zero-padded, UTC-`Z`-suffixed strings with 3-digit millis (`2018-12-07T12:30:37.810Z`). Lexicographic comparison of such strings matches chronological comparison. DynamoDB compares string attributes lexicographically with `<=`, `>=`, etc. The argument in the spec is sound and the plan includes a unit test asserting string comparison matches numeric comparison across second/minute/hour boundaries — a good edge-case test.

**Native `{ S: ... }` literals — CORRECT and well-justified.** Avoiding `@aws-sdk/util-dynamodb`'s `marshall` keeps the peer-dep surface to just `@aws-sdk/client-dynamodb`. All attributes are strings (ISO dates + hostname), so the literal shape is trivial. Good fit for the minimal-dependency principle.

**`buildKey` helper — CORRECT.** Single helper used by all three operations ensures the sort-key path can't be forgotten in one operation. The plan's risk table explicitly calls this out.

## Gaps and Issues

1. **`:lockedAt` naming is confusing.** It serves as both the `lockedAt` field value and the `now` comparison bound. Recommend a clarifying comment or a separate `:now` placeholder. Not a bug.

2. **Partition-key string interpolation in unlock.** `` `attribute_exists(${this.partitionKey})` `` interpolates the user-supplied `partitionKey` directly into the condition expression. DynamoDB attribute names are constrained (alphanumeric + underscore + dot), and `partitionKey` is user config (not untrusted input), so this is low-risk. However, if `partitionKey` ever contained a reserved word or special character, the expression would break (or, in a pathological case, be injectable). Best practice: use `ExpressionAttributeNames` (e.g., `#pk`) and reference `attribute_exists(#pk)`, which also handles reserved-word partition keys. Recommend adopting `ExpressionAttributeNames` for the partition key in all three operations for robustness. Low severity.

3. **Sort-key API limitation.** `sortKey.value` is fixed at construction time — ALL lock names share the same sort-key value. This is documented ("composite-key tables share a single sort-key value across all locks"), but it's a real limitation: if a user wants per-lock sort-key values (e.g., sharding by tenant), this API doesn't support it. The spec frames this as "for tables that require composite keys" (i.e., reuse an existing composite-key table), which is a reasonable scope. But the README should be explicit that this is a single-namespace discriminator, not a per-lock dimension, to avoid user surprise.

4. **No table attribute-type requirement documented.** The spec says the table "must already exist" but doesn't state that the partition key (and sort key, if used) must be string-typed (`S`). The values are written as `{ S: ... }`; a mismatched table (e.g., partition key typed as `N`) would fail at runtime. Add a one-line requirement.

5. **`beforeEach` cleanup is underspecified.** "Delete all items (or use a unique partition key per test)" is non-committal. Pick one (per-test unique lock names is cheaper than a `Scan`+batch-delete) and document it.

6. **No `TimeToLiveSpecification` note in non-goals is slightly thin.** The spec lists TTL as a non-goal ("Document TTL as an optional optimization in the README"). This is fine, but the README guidance should specify which attribute to wire TTL to (`lockUntil`) and the caveat that DynamoDB TTL deletion is eventual (up to 48h) — so it's a reclamation optimization, not a correctness mechanism. The spec's non-goal framing is acceptable; just ensure the README carries the detail.

## Recommendations

1. Use `ExpressionAttributeNames` (`#pk`) for the partition key in all three operations to handle reserved words robustly.
2. Add a clarifying comment or separate `:now` placeholder so the `:lockedAt` double duty is obvious to maintainers.
3. Document the string-typed partition/sort-key requirement in the spec and README.
4. Commit to a specific `beforeEach` cleanup strategy in the integration test plan.
5. Carry the TTL-as-reclamation-optimization guidance into the README with the `lockUntil` attribute recommendation and the eventual-deletion caveat.

## Verdict: APPROVED WITH NOTES

The `UpdateItem` + `ConditionExpression` mechanism is correct, the ISO-8601 comparison reasoning is sound, and the `attribute_not_exists(lockUntil)` OR-short-circuit for new items is handled correctly. The notes are about naming clarity, expression-attribute-name robustness, sort-key API scoping, and table-requirement documentation — none of which affect correctness for the documented happy path.
