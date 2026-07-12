# AGENTS.md

Instructions for AI agents working on the TSLock codebase.

## Project overview

TSLock is a TypeScript port of [ShedLock](https://github.com/lukas-krecan/ShedLock) — a distributed lock library for scheduled tasks. It is a pnpm-workspaces monorepo with a small core package and 23+ provider packages, each backed by a different storage engine.

**Current state: docs-only.** All design docs (vision, architecture, specs, plans, reviews) are complete in `docs/`. No implementation code exists yet. Implementation follows the plans in `docs/plans/`.

## Repository layout

```
tslock/
├── docs/
│   ├── 00-vision.md          # product vision, scope, provider matrix
│   ├── 01-architecture.md    # monorepo structure, core abstractions, provider categories
│   ├── specs/                # 23 per-provider specs (NN-name.md)
│   ├── plans/                # 23 per-provider implementation plans (NN-name.md)
│   └── reviews/              # 23 independent reviews of each spec/plan (NN-name.md)
├── packages/                 # (not yet created — will hold @tslock/* packages)
├── README.md
├── AGENTS.md                 # this file
├── pnpm-workspace.yaml       # (not yet created)
├── tsconfig.base.json        # (not yet created)
└── package.json              # (not yet created)
```

The `NN-` prefix on spec/plan/review files is a 2-digit number that matches across all three directories (e.g., `docs/specs/06-spanner.md`, `docs/plans/06-spanner.md`, `docs/reviews/06-spanner.md`).

## Read these first

Before implementing anything, read in this order:

1. `docs/00-vision.md` — what TSLock is and isn't, provider matrix, resolved design decisions.
2. `docs/01-architecture.md` — monorepo structure, core abstractions with TS types, `AsyncLocalStorage`-based `LockAssert`/`LockExtender`, provider categories (A/B/C/D/E/F/G/H/I), test architecture.
3. `docs/specs/00-core.md` — the core abstractions spec. Everything else depends on this.
4. `docs/plans/00-core.md` — the core implementation plan.
5. `docs/reviews/00-core.md` — the core review (notes on underspecified areas).
6. The spec + plan + review for the specific provider you're implementing.

## Key design decisions (do not deviate without asking)

| Decision | Choice |
|---|---|
| Monorepo | pnpm workspaces |
| Package scope | `@tslock/*` |
| Module format | Dual ESM + CJS (tsup) |
| Node.js minimum | 20+ |
| Test framework | Vitest |
| Config API | Plain typed objects + `parseDuration()` — no builder classes |
| Concurrency model | `AsyncLocalStorage` (replaces Java's `ThreadLocal`) |
| Lock operations | All async (`Promise<SimpleLock | undefined>`) |
| SQL packages | `@tslock/sql-support` (shared) + `@tslock/sql` + `@tslock/kysely` + `@tslock/drizzle` |
| Redis packages | `@tslock/redis-core` (shared) + `@tslock/redis` (node-redis) + `@tslock/redis-ioredis` |
| Ignite | Deferred to v2 (immature Node.js driver) — 23 providers for v1 |
| Framework integrations | Out of scope for v1 (no NestJS/Express/Fastify decorators) |
| Metrics | Out of scope for v1 (`LockingTaskExecutorListener` is the extension point) |

## Provider categories

Providers fall into categories that determine their implementation pattern:

| Category | Pattern | Providers |
|---|---|---|
| **A — StorageBasedLockProvider** | `StorageAccessor` (insert/update/unlock/extend) + `StorageBasedLockProvider` | SQL, Neo4j, Couchbase, Spanner, Firestore, Datastore, S3, GCS, Cassandra |
| **B — Direct LockProvider** | Custom mechanism, implements `LockProvider` directly | Mongo, DynamoDB, ES/OpenSearch, ArangoDB |
| **C — Redis** | `SET NX PX` + Lua scripts, shared `InternalRedisLockProvider` | Redis, Redis-ioredis |
| **D — Hazelcast** | IMap entry-level lock + get-check-put + TTL | Hazelcast |
| **E — ZooKeeper** | PERSISTENT znodes + version CAS | ZooKeeper |
| **F — Etcd** | Lease + txn (version == 0) | Etcd |
| **G — Memcached** | `add` (fails if exists) + `replace` | Memcached |
| **H — NATS JetStream** | KeyValue bucket + create/update with revision | NATS |
| **I — InMemory** | `Map<string, LockRecord>` | InMemory (only `ExtensibleLockProvider` among specialized) |

## Implementation conventions

When implementing a provider package:

1. **Package structure:** `src/index.ts` (exports), `src/<provider>-configuration.ts` (config + resolver), `src/<provider>-storage-accessor.ts` (or direct provider), `src/<provider>-lock-provider.ts` (factory), `__tests__/` (unit + integration).

2. **Peer dependencies:** `@tslock/core` (required) + the canonical driver (required). Never bundle the driver — users install the version they need.

3. **Config:** plain typed interface + `resolve<Provider>Configuration(input)` that merges defaults, validates, and returns a frozen object. No builder classes. Use `Partial<ColumnNames>` for column/field name overrides.

4. **Error handling:** distinguish "lock not acquired" (return `false`/`undefined`) from "storage error" (throw). For `StorageBasedLockProvider` accessors, `updateRecord` should propagate "row missing" errors to trigger `LockRecordRegistry` cache clear (Couchbase pattern) — see review 09-s3 for the counterexample.

5. **ISO timestamps:** use `Utils.toIsoString(epochMillis)` for ISO-8601 with exactly 3 fractional digits (natural sort ordering). `ClockProvider.now()` for the current time (truncated to millis, overridable for tests).

6. **Tests:** unit tests with mocked driver + integration tests with testcontainers/emulator. Run the shared contract from `@tslock/test-support` (`lockProviderIntegrationTests`, `storageBasedLockProviderIntegrationTests`, `extensibleLockProviderIntegrationTests`, `fuzzTests`).

7. **No comments in code** unless explicitly asked.

8. **Dual format:** `tsup.config.ts` with `format: ['esm', 'cjs']`, `dts: true`, `clean: true`, `sourcemap: true`.

## Review findings to address during implementation

The reviews in `docs/reviews/` identified issues to fix. Key ones:

- **S3 (09) — NEEDS REVISION:** `updateRecord` returns `false` on 404, preventing `LockRecordRegistry` cache clear. Should throw to self-heal (matching Couchbase). Same issue in GCS (10) and Spanner (06).
- **Firestore (07):** `unlock` missing `lockUntil >= now` check (ShedLock's `updateOwn` checks both `lockedBy` AND `lockUntil`). Datastore (08) correctly omits it (ShedLock's Datastore `updateOwn` only checks `lockedBy`).
- **ArangoDB (11):** `extend` is non-transactional with no CAS — TOCTOU race. Use `ifMatch: existing._rev` or wrap in a stream transaction. Also: `exclusiveCollections` is Enterprise-only — implement `writeCollections` fallback for Community Edition.
- **Neo4j (04), Couchbase (05), Cassandra (12):** "rejects extend from different lockedBy" integration test creates an intruder provider but never exercises it — fix to actually test cross-instance rejection.
- **OpenSearch (15):** integration test uses HTTPS + `DISABLE_SECURITY_PLUGIN` but that flag forces HTTP — connection will fail. Fix the URL scheme.
- **Redis (16):** `lockAtLeastFor > 0` unlock bypasses `safeUpdate` Lua path — document or fix.
- **Memcached (20):** TTL uses `Math.ceil` but ShedLock uses `Math.floor(ttl/1000) + 1` — adopt the +1 safety buffer.

Read the full review for each provider before implementing it.

## Commands (once code exists)

```bash
pnpm install              # install all workspace deps
pnpm -r typecheck         # tsc --noEmit across all packages
pnpm -r test              # vitest run (unit tests) across all packages
pnpm -r test:integration  # integration tests (requires Docker / emulators)
pnpm -r build             # tsup build across all packages
```

## Rules

- **No code until explicitly asked.** The user's current task is docs-only. When implementation begins, follow the plans in `docs/plans/`.
- **Never commit unless explicitly asked.**
- **Prompt before deleting files or directories.**
- **No unrequested abstractions.** No interface with one implementation, no factory for one product, no config for a value that never changes.
- **Shortest working diff wins** — but only after understanding the problem. Read the spec, plan, and review for the area you're touching first.
