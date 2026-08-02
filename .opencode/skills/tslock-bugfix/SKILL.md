---
name: tslock-bugfix
description: Reproduce-first bug-fixing workflow for TSLock. Use this skill whenever the user reports a bug, regression, failing test, incorrect behavior, race, compatibility problem, or asks to fix an issue. Reproduce the failure, implement the smallest correct fix, verify, obtain an independent review, and repeat until done. Do not use it for a new feature, architectural refactor, documentation-only work, or test-only improvement; route those to tslock-sdd, tslock-doc-improver, or tslock-test-improver.
---

# TSLock Bug Fix

A bug fix is complete only when the failure is understood, a regression is guarded against, the fix is verified, and an independent review finds no remaining issue. Keep the change narrow, but do not weaken the fix to preserve a broken implementation pattern.

## 1. Triage and reproduce

- Read `CONTRIBUTING.md`, `AGENTS.md`, the relevant architecture docs, package README, implementation, tests, and historical review findings.
- Identify the affected package, public behavior, backend, runtime, and likely failure boundary.
- Establish a deterministic reproduction using an existing test or a minimal new failing test. Capture the expected and actual behavior, error output, and environment assumptions.
- Reproduce before editing production code. If the report cannot be reproduced, inspect logs and tests, add the smallest diagnostic or characterization test that is useful, and ask for missing information rather than guessing.
- Check whether the issue is actually a feature request or architectural mismatch. If so, stop and hand off to `tslock-sdd`.

## 2. Diagnose

Trace the failure to a root cause, not just the first failing assertion. For lock code, explicitly consider ownership, expiry, clock values, async interleaving, atomicity/CAS, contention semantics, cache invalidation, and driver error mapping. Compare the implementation with the relevant spec, plan, review, ShedLock behavior where applicable, and neighboring providers.

Write down the invariant the fix must restore and the non-goals that keep the patch focused.

## 3. Implement the smallest correct fix

- Add or preserve a regression test that fails before the fix and passes after it.
- Make the minimal production change that restores the invariant, reusing existing helpers and patterns.
- Preserve the distinction between lock contention (`false`/`undefined`) and storage/programming errors.
- Do not edit immutable historical specs, plans, or reviews. If the bug exposes a design gap, record it in the issue or propose a new SDD change rather than silently rewriting history.
- Update relevant user-facing documentation or changesets when behavior or API semantics change.

## 4. Verify

Run the regression test first, then targeted package checks:

```bash
pnpm check
pnpm -r typecheck
pnpm -r test
```

Run the relevant integration suite when the bug involves a real backend, concurrency, serialization, or driver behavior. Run `pnpm test:integration`, `pnpm -r build`, and `pnpm check:packed-peers` when the affected scope or repository policy requires them. Record unavailable Docker/services as environmental skips, not successes.

Check that the test fails against the pre-fix behavior when practical and that the regression test would catch a reintroduction of the defect.

## 5. Independent review and repeat

Ask a fresh reviewer to inspect the reproduction, root cause, diff, regression test, neighboring code, and verification output. The reviewer should look for incomplete fixes, hidden races, over-broad behavior changes, missing error cases, weak assertions, and docs/changeset omissions.

If review or verification finds an issue, return to diagnosis or implementation, fix it, rerun verification, and review again. Continue until the review is clean or an explicit architectural/environmental blocker needs the user. Report the reproduction, root cause, fix, tests, review result, and any remaining limitation.
