# AGENTS.md

Instructions for AI agents working on the TSLock codebase.

## Project overview

TSLock is a TypeScript port of [ShedLock](https://github.com/lukas-krecan/ShedLock) — a distributed lock library for scheduled tasks. It is a pnpm-workspaces monorepo with a small core package and 23+ provider packages, each backed by a different storage engine.

**Current state:** the packages are implemented and the approved architecture-hardening work is being completed incrementally. Design docs remain in `docs/`; implementation follows `docs/plans/`. Middleware integrations are implemented, with their original exploration docs retained for reference.

## Repository layout

```
tslock/
├── docs/
│   ├── 00-vision.md          # product vision, scope, provider matrix
│   ├── 01-architecture.md    # monorepo structure, core abstractions, provider categories
│   ├── specs/                # 28 specs, including architecture hardening and verification follow-up
│   ├── plans/                # 28 implementation plans
│   └── reviews/              # 29 reviews, including the supplemental 24-middleware-code review
├── packages/                 # @tslock/* packages — providers, infrastructure, and middleware
├── README.md
├── AGENTS.md                 # this file
├── pnpm-workspace.yaml       # workspace and build-script policy
├── tsconfig.base.json        # shared TypeScript configuration
└── package.json              # root scripts and dev dependencies
```

The `NN-` prefix on spec/plan/review files is a 2-digit number that matches across all three directories (e.g., `docs/specs/06-spanner.md`, `docs/plans/06-spanner.md`, `docs/reviews/06-spanner.md`). `docs/reviews/24-middleware-code.md` is the one supplemental review sharing the `24` prefix.

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
| Node.js minimum | 22+ |
| Test framework | Vitest |
| Config API | Plain typed objects + `parseDuration()` — no builder classes |
| Concurrency model | `AsyncLocalStorage` (replaces Java's `ThreadLocal`) |
| Lock operations | All async (`Promise<SimpleLock | undefined>`) |
| SQL packages | `@tslock/sql-support` (shared) + `@tslock/sql` + `@tslock/kysely` + `@tslock/drizzle` |
| Redis packages | `@tslock/redis-core` (shared) + `@tslock/redis` (node-redis) + `@tslock/redis-ioredis` |
| Ignite | Deferred to v2 (immature Node.js driver) — 23 providers for v1 |
| Framework integrations | Implemented as shared middleware-core plus Express, Fastify, Koa, and Hono adapters; the original spec/plan/review remain in `docs/` for reference. |
| Metrics | Out of scope for v1 (`LockingTaskExecutorListener` is the extension point) |
| Linting | Biome |

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

## Development Workflow

Classify the requested work before editing. The executable, detailed workflows live in [`.opencode/skills/`](./.opencode/skills/) so agent-driven and human-driven work follow the same repository policy.

| Contribution | Agent skill | Use when | Do not use when |
|---|---|---|---|
| Bug fix | `tslock-bugfix` | Reproducible bug, regression, race, or incorrect behavior | New feature/design, docs-only, or test-only work |
| Feature/provider | `tslock-sdd` | New behavior, provider, concept, public/cross-package contract, or substantial refactor | Isolated bug, docs-only, or test-only work |
| Documentation | `tslock-doc-improver` | Reconcile or improve READMEs, examples, links, contributor docs, specs/plans references, or API descriptions | Runtime defect or new architecture is the primary problem |
| Tests | `tslock-test-improver` | Coverage, assertions, integration, fuzz, shared contracts, or test infrastructure | Production bug or new feature design is the primary problem |
| Refactor | `tslock-sdd` if substantial; fast track if local/mechanical | Architecture, public contracts, or multiple packages are affected | Trivial rename or mechanical cleanup |

A tiny typo, formatting-only change, or obvious local mechanical edit can use the fast track. It still needs the narrowest meaningful verification. If a fast-track change reveals a new design, cross-package impact, or a production defect, stop and switch to the matching skill.

### Full SDD workflow

Use [`tslock-sdd`](./.opencode/skills/tslock-sdd/SKILL.md) for substantial changes. It runs these stages sequentially:

1. **Interview and discovery** — resolve scope, constraints, compatibility, edge cases, and tests.
2. **Spec** — create immutable `docs/specs/<NN>-<name>.md` with behavior, API, errors, invariants, and test expectations.
3. **Plan** — create immutable `docs/plans/<NN>-<name>.md` with ordered files, implementation steps, verification, and docs.
4. **Implement** — implement from the spec and plan with unit/integration tests and repository conventions.
5. **Verify** — run targeted checks and the full suite required by the scope.
6. **Review** — obtain an independent review against architecture, spec, plan, code, tests, and docs.
7. **Repeat** — route findings to the lowest affected stage and repeat verification/review until done, up to three rounds before escalation.
8. **Document and hand off** — reconcile current docs and report artifacts, checks, review outcome, and deferred work.

The focused skills apply the same verify/review/repeat discipline without creating SDD artifacts for their narrower work: [`tslock-bugfix`](./.opencode/skills/tslock-bugfix/SKILL.md), [`tslock-doc-improver`](./.opencode/skills/tslock-doc-improver/SKILL.md), and [`tslock-test-improver`](./.opencode/skills/tslock-test-improver/SKILL.md). `tsock-doc-improver` and `tslock-sd` are not skill names; they are corrected here to the canonical names above.

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

The architecture-hardening slices have addressed the core/Redis fixes, provider error taxonomy and missing-record behavior, TTL migration, middleware hot-path work, and priority integration coverage. Remaining follow-up work is tracked in `docs/plans/25-architecture-improvements.md` and includes broader container coverage plus final repository verification.

## Setup

Before running any commands, ensure the correct Node.js version and pnpm are active:

```bash
nvm use                # match the version in .nvmrc
corepack enable pnpm   # ensure pnpm is available via corepack
```

## Commands

```bash
pnpm install              # install all workspace deps (optional testcontainers native builds are denied by policy)
pnpm -r typecheck         # tsc --noEmit across all packages
pnpm -r test              # vitest run (unit tests) across all packages
pnpm test:integration     # in-memory, MongoDB, and PostgreSQL suites; Redis is opt-in via TSLOCK_REDIS_INTEGRATION=1
pnpm -r build             # tsup build across all packages
pnpm bench                # build artifacts and run manual performance measurements
pnpm check:packed-peers   # verify packed peer dependencies contain no workspace:* ranges
pnpm format               # auto-format all files with Biome
pnpm format:check         # check formatting without writing
pnpm lint                 # lint with Biome
pnpm lint:fix             # lint and apply safe fixes
pnpm check                # combined format check + lint
pnpm check:fix            # combined format + lint with fixes
```

## Publishing

All releases are done locally (npm 2FA is interactive):

```bash
pnpm login                              # one-time auth with 2FA
pnpm changeset                          # describe changes, pick semver bump
pnpm version-packages                   # bump versions + update CHANGELOGs
pnpm format                             # reformat package.json (changeset uses JSON.stringify)
git add -A && git commit -m "chore: release v<version>"
pnpm publish -r                         # publish all packages to npm
git tag v<version> && git push --follow-tags
```

All `@tslock/*` packages share one version (lockstep via Changesets fixed mode).
CI runs verification plus a non-blocking `pnpm audit --prod`; the integration job runs the Docker-backed suites. Packed peer dependency verification is a local release-gate command. The workspace explicitly denies optional `cpu-features` and `ssh2` install scripts. Docker-over-SSH is unsupported under the default policy; a local-only override may set both entries to `true` in `pnpm-workspace.yaml` before reinstalling with the required native toolchain.

## Rules

- **No code until explicitly asked.** When implementation begins, follow the plans in `docs/plans/`.
- **Never commit unless explicitly asked.**
- **Prompt before deleting files or directories.**
- **No unrequested abstractions.** No interface with one implementation, no factory for one product, no config for a value that never changes.
- **Shortest working diff wins** — but only after understanding the problem. Read the spec, plan, and review for the area you're touching first.
- **Commit messages must reference an issue.** Every commit must include `#<NN>` or `Closes #<NN>` in the footer. Commits without an issue reference will be rejected.
- **Specs, plans, and reviews in `docs/` are immutable once written.** New work gets new files (`docs/specs/<NN>-<name>.md`, etc.). Never edit, update, or backport changes into existing `docs/specs/`, `docs/plans/`, or `docs/reviews/`. The only exception is a user explicitly saying otherwise.
