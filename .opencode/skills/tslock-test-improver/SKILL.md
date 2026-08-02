---
name: tslock-test-improver
description: Test-coverage and test-quality workflow for TSLock. Use this skill whenever the user asks to add, improve, strengthen, repair, review, or expand tests, integration coverage, fuzz coverage, shared contracts, assertions, or test infrastructure without making a new feature the primary goal. Review coverage, implement meaningful tests, verify, independently review, and repeat until done. Do not use it for a production bug fix, new feature design, or documentation-only task; route those to tslock-bugfix, tslock-sdd, or tslock-doc-improver.
---

# TSLock Test Improver

Tests should expose behavioral contracts and failure modes, not inflate counts. Prefer deterministic, meaningful tests that would fail for a plausible regression and that match the provider's real concurrency and backend semantics.

## 1. Review the existing coverage

- Read `CONTRIBUTING.md`, `AGENTS.md`, the relevant architecture/spec/plan/review, package README, implementation, and nearby tests.
- Identify the public behavior and invariants: acquisition and contention, unlock, expiry, `lockAtLeastFor`, extension/ownership, errors, concurrency, serialization, configuration validation, and lifecycle cleanup as applicable.
- Inspect shared contracts in `@tslock/test-support`, unit-test patterns, integration configuration, CI selection, and available Docker/emulator services.
- Build a coverage matrix mapping behavior/risk → existing test → gap → proposed test. Look for missing negative cases, weak assertions, tests that never exercise the intended actor, and integration tests that are skipped or misconfigured.
- If the coverage gap is caused by a production defect, stop and route to `tslock-bugfix`. If tests require a new public behavior or architecture, route to `tslock-sdd`.

## 2. Design useful tests

Choose the narrowest test level that proves the behavior:

- unit tests for pure logic, configuration, time, error mapping, and mocked driver interactions;
- provider tests for atomic operations, ownership, CAS, and driver error translation;
- shared contract tests for common provider behavior;
- integration tests for real backend semantics, transactions, TTLs, indexes, and concurrent attempts;
- fuzz or stress tests for interleavings and invariants when deterministic tests cannot cover the risk.

Use fixed clocks, controlled schedulers, isolated lock names, and explicit cleanup where possible. Assert outcomes and important calls, not incidental implementation details. Avoid timing sleeps unless the backend behavior genuinely requires them; use synchronization barriers or injected time instead.

## 3. Implement

- Add tests that fail for the missing coverage before changing tests to make them pass.
- Strengthen existing tests when they currently pass without exercising the behavior they claim to verify.
- Reuse `@tslock/test-support` contracts and repository helpers rather than duplicating provider logic.
- Keep tests independent, deterministic, and compatible with Node 22, Vitest, Biome, and the workspace's native-build policy.
- Change production code only when a test exposes a clear defect or a minimal testability seam is required; hand a discovered defect to `tslock-bugfix` when it is outside the requested test-improvement scope.
- Update test documentation or package README instructions when coverage requires a new service or environment variable.

## 4. Verify

Run the new or affected tests first, then:

```bash
pnpm check
pnpm -r typecheck
pnpm -r test
```

Run the relevant integration or fuzz suite when applicable. Run `pnpm test:integration` for backend/container changes and broader `pnpm -r build` or `pnpm check:packed-peers` when package/build behavior is touched. Confirm the tests are actually selected by the intended scripts and are not silently skipped.

## 5. Independent review and repeat

Ask a fresh reviewer to examine the coverage matrix, test design, failure-before/fix-after evidence, determinism, cleanup, assertion strength, backend realism, and CI execution path. Fix findings, rerun verification, and review again until the coverage gap is closed or a documented environmental limitation remains. Report what risk is now covered, what commands ran, and what cannot be exercised locally.
