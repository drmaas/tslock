# Review: Verification Follow-up

## Scope

This review covers the implementation of `docs/specs/27-verification-follow-up.md` and `docs/plans/27-verification-follow-up.md`, including the native build policy, shared test-support runtime boundary, integration contracts, and packed-peer release gate.

## Findings

- `pnpm-workspace.yaml` explicitly denies the optional `cpu-features` and `ssh2` install scripts, and `pnpm install --frozen-lockfile` completes successfully under pnpm 11.14.0.
- `@tslock/test-support` externalizes `vitest` from its tsup bundle and declares it as a peer dependency, preventing a second Vitest runtime from causing false `No test suite found` failures.
- Extensible and storage-based integration-contract wrappers mark themselves as extensible, so the generic non-extensible-provider assertion is not applied to providers that support `extend()`.
- Mock-clock contract tests use stable timestamps and advance time explicitly rather than changing on every clock read.
- `scripts/check-packed-peers.mjs` uses pnpm 11-compatible `pack` arguments and reports pack stderr when a package fails. The packed-peer check passes for all `@tslock/*` packages.
- The changeset explicitly includes `@tslock/test-support`, and the numbered spec/plan/review set is complete through 27.

## Validation

Passed:

- frozen workspace install;
- `pnpm check`;
- `git diff --check`;
- package metadata assertions for all 33 workspace packages;
- packed-peer verification;
- JavaScript syntax checks for repository tooling and benchmark scripts;
- full workspace typecheck (33 projects);
- full unit suite (502 tests passed, 1 skipped provider live-integration test);
- full workspace build (33 projects; only existing tsup export-condition warnings);
- `pnpm audit --prod` with no known vulnerabilities;
- in-memory integration contract (8 tests passed);
- PostgreSQL integration contract (9 tests passed);
- independent code review with no remaining implementation findings.

The aggregate integration command also includes Redis suites, which are intentionally skipped unless Redis integration is enabled and a service is available. MongoDB integration was blocked in this environment by testcontainer hostname resolution (`getaddrinfo ENOTFOUND`), not by a reported source assertion failure.

## Decision

**Approved.** The verification and release-gate corrections are complete. Remaining integration limitations are environment-specific and explicitly documented rather than treated as source regressions.
