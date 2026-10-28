# Review: Architecture Improvements

## Scope

This review covers the approved v1.x architecture-hardening work in `docs/specs/25-architecture-improvements.md` and `docs/plans/25-architecture-improvements.md`.

Implemented areas include:

- core hostname, TTL, lock-name, registry, reentrancy, keep-alive, and unlock-observability hardening;
- Redis ownership-token and `lockAtLeastFor` correctness;
- provider configuration error taxonomy and missing-record behavior;
- middleware duration caching, route snapshots, typing, and lifecycle documentation;
- in-memory, Redis, MongoDB, and PostgreSQL integration-test coverage;
- CI frozen-lockfile installation, dependency audit, integration jobs, package metadata, benchmarks, and packed-peer verification.

## Review findings

### Correctness

- Lock names are validated centrally by `@tslock/core` and documented across identifier/key-based providers.
- Storage-based provider registry state is cleared when update operations fail, allowing subsequent acquisition attempts to recover after external record deletion.
- Firestore, Datastore, and Spanner missing-record paths now fail loudly instead of being mistaken for an occupied lock.
- Redis unlock honors `lockAtLeastFor` for both safe and non-safe update paths, and Redis ownership values use the real hostname plus a UUID.
- Middleware global durations are resolved once, registered route configurations are snapshotted, and mutable direct route objects are not cached indefinitely.
- MongoDB and PostgreSQL integration containers use timed setup and `finally`-protected cleanup.

### Security and resilience

- Control characters and lock names exceeding 1024 UTF-8 bytes are rejected centrally.
- CI uses `--frozen-lockfile` and runs non-blocking `pnpm audit --prod`.
- Keep-alive and unlock failures have observable hooks while preserving task-result semantics.
- Redis ownership checks remain value-verified by default.

### Modularity and tooling

- All published workspace packages expose `./package.json` and declare `sideEffects: false`.
- The benchmark harness remains outside the pnpm workspace and measures in-memory, executor, and middleware lifecycle overhead.
- `check:packed-peers` packs every `@tslock/*` package independently and verifies that published peer dependencies contain no unresolved `workspace:*` ranges.
- The release script invokes the packed-peer check before publishing.

## Validation

Passed:

- Biome repository check;
- `git diff --check`;
- package metadata assertions for all 33 workspace packages;
- JavaScript syntax checks for benchmark and packed-peer scripts;
- benchmark smoke run for lock, executor, and middleware lifecycle paths;
- independent code review with no remaining implementation findings.

The package typecheck, unit-test, build, and packed-peer command executions were blocked in this environment by pnpm's existing ignored-build policy for `cpu-features` and `ssh2` (`ERR_PNPM_IGNORED_BUILDS`). The repository instructs maintainers to resolve this with `pnpm approve-builds`; this is an environment setup issue rather than a reported source failure.

## Decision

**Approved.** The implementation matches the approved architecture-hardening scope. Broader provider-specific container suites and full repository verification remain follow-up work described by the plan.
