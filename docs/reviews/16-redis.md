# Review: @tslock/redis-core + @tslock/redis + @tslock/redis-ioredis

**Spec:** `docs/specs/16-redis.md`
**Plan:** `docs/plans/16-redis.md`

## Summary

The Redis provider spec describes three packages: `@tslock/redis-core` (shared `InternalRedisLockProvider`, `RedisTemplate` interface, `RedisLock`, and Lua scripts — zero Redis client deps) plus two thin adapters (`@tslock/redis` for node-redis, `@tslock/redis-ioredis` for ioredis). Acquisition uses `SET key value NX PX`, release/extend use atomic Lua scripts (`GET`-then-`DEL` / `GET`-then-`PEXPIRE`). The `redis-core` split is clean and mirrors ShedLock's Jedis/Lettuce structure. The locking algorithm is technically correct and matches ShedLock. The most significant concern is a usability/safety gap: the `lockAtLeastFor > 0` branch of `unlock` bypasses the `safeUpdate` Lua path entirely (even when `safeUpdate = true`), silently degrading safety — this is documented as ShedLock-matching behavior, but it is surprising given the `safeUpdate` flag's name. Several smaller notes (unused `get` method, mixed-quote Lua scripts breaking the claimed byte-for-byte parity, node-redis `eval` signature uncertainty, no Cluster integration test despite first-class Cluster support).

## Vision Alignment

Aligned. The three-package split (shared core + two adapters) is exactly the structure the vision specifies (§6.4). Framework-agnostic, minimal-dependency (`redis-core` has zero driver deps; adapters pull only their driver as peer), async-native, type-safe. Uses core abstractions (`ClockProvider.now()`, `Utils.toIsoString()`, `Utils.getHostname()`). The single-instance `SET NX PX` + Lua approach (not Redlock) is explicitly the ShedLock-matching choice and is correctly framed as a non-goal of Redlock. No framework/scheduler/pub-sub coupling.

## Architecture Alignment

Correctly specified as a DIRECT `ExtensibleLockProvider` (Category C, per `01-architecture.md` §6.3). The `redis-core` package holds `InternalRedisLockProvider` and `RedisTemplate`; the adapters implement `RedisTemplate` and delegate. This matches the architecture doc's stated structure precisely.

Package dependency rule compliance:
- `@tslock/redis-core` depends on `@tslock/core` only (zero Redis client deps). ✓
- `@tslock/redis` depends on `@tslock/core` + `@tslock/redis-core` + `redis` (peer). ✓
- `@tslock/redis-ioredis` depends on `@tslock/core` + `@tslock/redis-core` + `ioredis` (peer). ✓
- No provider depends on another provider. Shared logic in `redis-core`. ✓

The `RedisTemplate` interface in the spec matches the architecture doc's interface (`setIfAbsent`, `setIfPresent`, `eval`, `delete`, `get`) — though `get` is unused (see Gaps).

## Spec Completeness

Complete. The spec covers: package metadata for all three packages, the `RedisTemplate` interface, `InternalRedisLockProvider`, `RedisLockProviderConfig` (`keyPrefix`, `env`, `safeUpdate`), constants, key/value format, `RedisLock`, the two adapter providers and their templates, the full locking mechanism (lock/unlock/extend with code), the Lua scripts, the driver-difference table, error-handling table, file structure, dependencies, exports, and non-goals. The `safeUpdate` semantics are documented (including the `lockAtLeastFor > 0` bypass).

One omission: the spec's value format `ADDED:${isoNow}@${hostname}:${uuid}` claims the `ADDED:` prefix is "borrowed from ShedLock for readability when inspecting keys via `redis-cli`." The plan says to "Diff against ShedLock's Java source to confirm byte-for-byte parity." The two Lua scripts use inconsistent quote styles (`"get"`/`"del"` in DEL, `'get'`/`'pexpire'` in UPD), which would fail a byte-for-byte diff if ShedLock uses consistent quoting. This is minor (Lua treats both equivalently) but contradicts the plan's own parity goal.

## Plan Completeness

Complete and well-ordered. Twenty-four steps: `redis-core` scaffolding → constants → Lua scripts → `RedisTemplate` → `RedisLock` → `InternalRedisLockProvider` → `index.ts` → unit tests → verify; then the `redis` adapter (scaffolding → template → provider → index → unit tests → integration tests → verify); then the `redis-ioredis` adapter (same sequence, with the `EVALSHA`-with-`NOSCRIPT`-fallback logic). The unit tests for `redis-core` cover all `doUnlock` branches (`safeUpdate` × `lockAtLeastFor` matrix) and `doExtend` branches, including the `Number(result) === 1` coercion from string `'1'`. The ioredis unit tests cover the `NOSCRIPT` fallback path. Good.

The risk table is thorough and addresses: node-redis `eval` signature drift, ioredis `evalsha`/`eval` arity, `NOSCRIPT` detection, Cluster mode + `EVALSHA` (single-key → single slot, no cross-slot concern), node-redis `SET` options shape, `lockAtLeastFor` unlock ownership-check gap, `safeUpdate = false` unsafety, and Cluster integration-test complexity.

## Technical Correctness

**`SET key value NX PX lockAtMostFor` — CORRECT.** Single atomic round-trip. Redis applies `NX` (set if not exists) and `PX` (TTL in millis) atomically — no race between `SETNX` and `PEXPIRE`. Returns `"OK"` (acquired) or `null` (held). The TTL is the orphaned-lock safety net. Matches ShedLock.

**DEL_LUA_SCRIPT — CORRECT.** `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end` — atomic `GET`-then-`DEL`. Returns `1` on match+delete, `0` on mismatch. Redis executes Lua atomically (single-threaded), so `GET` and `DEL` are not interleavable. Prevents deleting a lock we no longer own (e.g., after expiry + re-acquisition). Matches ShedLock's release script.

**UPD_LUA_SCRIPT — CORRECT.** `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end` — atomic `GET`-then-`PEXPIRE`. Returns `1` on match+refresh, `0` on mismatch. Matches ShedLock's extend script.

**Key/value format — CORRECT.** Key `${prefix}:${env}:${lockName}` matches ShedLock. Value `ADDED:<isoNow>@<hostname>:<uuid>` embeds holder identity + nonce for ownership verification in the Lua scripts. The UUID (`crypto.randomUUID()`) ensures the value is unique per acquisition, so the Lua `GET == value` check correctly identifies the current holder.

**`lock` — CORRECT.** Builds key+value, calls `setIfAbsent(key, value, lockAtMostFor)`, returns `RedisLock` on `true` / `undefined` on `false`.

**`doExtend` — CORRECT.** `safeUpdate = true` → `UPD_LUA_SCRIPT` with `[value, String(expireMillis)]`; `Number(result) === 1` coerces both number `1` and string `'1'` (Redis may return either depending on driver/deserializer). `safeUpdate = false` → `SET key value XX PX expireMillis`. On success, returns a NEW `RedisLock` with the same `key`/`value`/`safeUpdate` and the `newConfig`. The original lock is invalidated by `AbstractSimpleLock.extend()`. Correct. The value is preserved across extends (same holder), so the ownership check in `UPD_LUA_SCRIPT` is consistent.

**`doUnlock` — CORRECT with a significant documented caveat (see Gaps).** The four-way branch:
- `lockAtLeastFor <= 0` + `safeUpdate = true` → `DEL_LUA_SCRIPT` (ownership-checked DEL). Safe.
- `lockAtLeastFor <= 0` + `safeUpdate = false` → plain `DEL`. Unsafe but documented.
- `lockAtLeastFor > 0` (either `safeUpdate`) → `SET key value XX PX lockAtLeastFor`. **This bypasses the Lua ownership check even when `safeUpdate = true`.** See Gaps.

**ioredis `EVALSHA` + `NOSCRIPT` fallback — CORRECT.** `evalsha(sha1, numkeys, ...keys, ...args)` with fallback to `eval(script, numkeys, ...keys, ...args)` on `NOSCRIPT`. The SHA1 is computed via `crypto.createHash('sha1').update(script).digest('hex')`, which matches Redis's script-hash algorithm. The `isNoScriptError` helper checks `e?.name === 'ReplyError' && /NOSCRIPT/.test(e?.message)` — correct for ioredis (which surfaces Redis `NOSCRIPT` as a `ReplyError`). This is the efficient, correct pattern. node-redis handles `EVALSHA`/`EVAL` internally when calling `client.eval(...)`, so the node-redis adapter is simpler. Correct.

**Cluster mode — CORRECT reasoning.** Lock keys use a single key (`KEYS[1]`), so in Redis Cluster they always hash to one slot. No cross-slot concern. The spec/plan documents this correctly.

## Gaps and Issues

1. **[SAFETY/USABILITY] `lockAtLeastFor > 0` unlock bypasses `safeUpdate` Lua path.** When `lockAtLeastFor > 0`, `doUnlock` calls `SET key value XX PX lockAtLeastFor` unconditionally — even when `safeUpdate = true`. The `XX` flag means "set only if exists" but does NOT verify the value matches. So if the lock expired and another instance acquired it (with a DIFFERENT value), the original holder's `unlock` call would OVERWRITE the new holder's lock with the old value and a shorter TTL — releasing a lock the original holder no longer owns. This is a real correctness degradation that is SILENT: a user who sets `lockAtLeastFor: '5s'` and relies on `safeUpdate: true` (the default) reasonably expects ownership verification on unlock, but does not get it in the `lockAtLeastFor > 0` path. In fact, `safeUpdate: true` with `lockAtLeastFor > 0` is LESS safe than `safeUpdate: true` with `lockAtLeastFor = 0` (which uses the Lua `GET`-then-`DEL`).

   The spec documents this as matching ShedLock's behavior and lists a stricter Lua-based path (`GET`-then-`PEXPIRE`) as a Non-Goal. This is a defensible deliberate choice, but:
   - The `safeUpdate` flag name is misleading for the `lockAtLeastFor > 0` case. Consider documenting this interaction prominently in the README (a "Caveats" section), OR renaming the flag to make the scope explicit (e.g., `safeUpdateOnlyWithoutLockAtLeastFor` — ugly but honest), OR implementing the stricter Lua path for the `lockAtLeastFor > 0` branch too (the `UPD_LUA_SCRIPT` already does `GET`-then-`PEXPIRE`; reusing it for the minimum-hold unlock would close the gap with minimal code).
   - The plan's risk table mitigates this with "the holder calls `unlock` well within `lockAtMostFor`." This is the ShedLock assumption, but it relies on `lockAtMostFor` being set generously. A user who sets `lockAtMostFor` tightly (close to actual task duration) and `lockAtLeastFor > 0` is at risk. The README should state this interaction explicitly.

   **Recommendation:** strongly consider reusing `UPD_LUA_SCRIPT` (or a variant that `PEXPIRE`s to `lockAtLeastFor`) for the `safeUpdate = true` + `lockAtLeastFor > 0` unlock path. This closes the gap, matches the spirit of `safeUpdate`, and diverges only trivially from ShedLock (document the divergence). At minimum, document the interaction prominently.

2. **[DEAD API] `RedisTemplate.get` is unused.** The interface defines `get(key): Promise<string | null>`, but no method in `InternalRedisLockProvider`, `RedisLock`, or the locking algorithm calls it. `lock` uses `setIfAbsent`; `doUnlock` uses `eval`/`delete`/`setIfPresent`; `doExtend` uses `eval`/`setIfPresent`. `get` is speculative interface surface — it forces both adapters to implement a method that is never exercised by the provider, and it's untested by the provider's logic. Recommend removing `get` from `RedisTemplate` (the "no unrequested abstractions" principle). If it's intended for user-facing inspection, document that and export it as a separate utility, not on the internal `RedisTemplate`.

3. **[DOC ACCURACY] Mixed-quote Lua scripts break the claimed byte-for-byte ShedLock parity.** The plan says "Diff against ShedLock's Java source to confirm byte-for-byte parity." `DEL_LUA_SCRIPT` uses `"get"`/`"del"` (double quotes); `UPD_LUA_SCRIPT` uses `'get'`/`'pexpire'` (single quotes). Lua treats both equivalently, but a byte-for-byte diff against ShedLock (which uses consistent quoting) would fail. Either standardize on single quotes ( ShedLock's convention) to make the diff meaningful, or drop the "byte-for-byte parity" claim. Minor, but the claim is misleading as written.

4. **[UNCERTAINTY] node-redis `eval` signature.** The plan's Step 12 uses `client.eval(script, { keys, arguments: args })` and then hedges: "verify the exact shape against the installed version; `arguments` may be named `args` in some v4 minors." The peer dep is pinned to `^4.0.0`. The node-redis v4 `eval` signature is `client.eval(script, { keys, arguments })` (the `arguments` field is the documented shape across v4.x). The hedge is mildly concerning — the spec/plan should commit to the confirmed v4 shape and add a unit test asserting the exact call shape, rather than deferring to "verify at implementation time." If there's genuine uncertainty, pin to a specific v4 minor (e.g., `^4.6.0`) where the signature is confirmed.

5. **[TEST COVERAGE GAP] No Cluster integration test despite first-class Cluster support.** The spec's `IoRedisLockProvider` accepts `Redis | Cluster` and the driver-difference table lists "Cluster support: first-class — `Redis | Cluster` accepted." The plan's Step 23 makes the Cluster integration test optional ("If a cluster testcontainer is hard to set up, skip ... and rely on unit tests"). This means the Cluster code path (which exercises `client.eval`/`client.set` on a Cluster instance) has no integration coverage. Cluster mode has real behavioral differences (MOVED/ASK redirects, cross-slot errors) that the unit tests with a mocked client won't catch. Recommend either (a) running a cluster-mode testcontainer (e.g., `redis:7` with `--cluster-enabled yes` + a multi-node setup, or the `vishnuniva/redis-cluster` image), or (b) downgrading the claim from "first-class Cluster support" to "Cluster-typed client accepted; Cluster integration not tested." As written, the claim outruns the coverage.

6. **[MINOR] Redundant `isConflictError`-style clauses.** (Not present in Redis spec — this is an ES-review observation; skip.) Actually for Redis: the `Number(result) === 1` coercion is correct and handles both `1` (number) and `'1'` (string). Good. No issue here.

7. **[MINOR] `NodeRedisTemplate` / `IoRedisTemplate` exported "for subclass or inspect."** The exports section exports the template classes "so users can subclass or inspect." This is slightly speculative API surface — if there's no documented use case, consider not exporting them (the providers are the public API). Minor.

8. **[MINOR] No fuzz-test reference.** Same as the other providers — confirm the fuzz contract is bundled into `lockProviderIntegrationTests` or add it explicitly.

## Recommendations

1. **Address the `safeUpdate` + `lockAtLeastFor` interaction** (Gap 1) — either implement the Lua `GET`-then-`PEXPIRE` path for the `safeUpdate = true` + `lockAtLeastFor > 0` unlock branch (preferred, closes the gap with minimal code by reusing `UPD_LUA_SCRIPT`), or prominently document the interaction in the README's Caveats section. The current state makes `safeUpdate`'s name misleading.
2. **Remove `get` from `RedisTemplate`** (Gap 2) — it is unused dead interface surface.
3. **Standardize Lua script quoting** (Gap 3) — use single quotes consistently to match ShedLock and make the byte-for-byte diff claim accurate, or drop the claim.
4. **Commit to the node-redis v4 `eval` signature** (Gap 4) — remove the "verify at implementation time" hedge; pin to a confirmed v4 minor.
5. **Either add a Cluster integration test or downgrade the Cluster claim** (Gap 5) — the current "first-class Cluster support" outruns the test coverage.
6. Consider not exporting the template classes unless there's a documented use case (Gap 7).
7. Confirm the fuzz-test contract is wired (Gap 8).

## Verdict: APPROVED WITH NOTES

The `SET NX PX` + Lua-script release/extend algorithm is correct and matches ShedLock. The `redis-core` split is clean and the adapter pattern is sound. The notes range from a documented-but-surprising safety interaction (`safeUpdate` silently ignored in the `lockAtLeastFor > 0` unlock path — Gap 1, the most significant) to minor doc-accuracy and test-coverage items. None are fundamental design flaws, but Gap 1 deserves prominent README documentation at minimum and ideally a Lua-path implementation to honor the `safeUpdate` flag's name. The locking logic itself is correct.
