---
name: sdd
description: Spec-Driven Development workflow for TSLock. Use when the user asks to implement a new provider, add a new feature, make an architecturally substantial change, or requests work that requires 3+ files. Also use when the user says "full workflow", "sdd", "spec-driven", or wants to follow the TSLock development process. Do NOT use for small fixes (typos, single-function bugs, docs tweaks, chores) — those are fast-track.
---

# Spec-Driven Development for TSLock

Execute the full TSLock development workflow, producing artifacts at each stage. Before starting, read these foundation docs in order:

1. `docs/00-vision.md`
2. `docs/01-architecture.md`
3. `docs/specs/00-core.md`
4. `docs/plans/00-core.md`
5. `docs/reviews/00-core.md`
6. The spec + plan + review for the specific provider (if applicable)

## Classification

First, decide whether the change needs the full workflow or fast-track:

| If the change... | Then... |
|---|---|
| Touches only existing patterns, follows provider templates, fixes a bug in one function, docs typos, chores | Fast-track — implement directly, skip this workflow |
| Adds new concepts, changes cross-package contracts, requires 3+ files, or is architecturally substantial | Full workflow below |

If fast-track, run verification and report completion. If full workflow, proceed through stages 1-9 below.

## Namespacing

Pick `NN` — the next free two-digit number in `docs/specs/`. Check existing files to avoid collisions. Use the same `NN` across spec, plan, and review.

## Stage 1: Interview

Ask clarifying questions about scope, requirements, and constraints. Continue until all unknowns are resolved or the user delegates to your judgment. Key questions to resolve:

- What is the change? (new provider, new feature, refactor, bug fix)
- If a new provider: which category (A-I) does it fall into? What driver/library?
- What are the edge cases and error conditions?
- What are the test expectations? (unit + integration)
- Are there any deviations from existing patterns or architectural constraints?

## Stage 2: Spec

Write `docs/specs/<NN>-<name>.md`:

- Behavior, API surface, edge cases, error handling, test expectations
- Must align with `docs/01-architecture.md`
- Reference the provider category pattern from `docs/01-architecture.md`
- Include: overview, public API, configuration interface, lock lifecycle (lock/acquire, extend, unlock), error handling, edge cases, test plan

## Stage 3: Plan

Write `docs/plans/<NN>-<name>.md`:

- Step-by-step implementation order
- File changes list (files to create, modify, or delete)
- Verification commands as a line item
- Documentation updates as a line item (README.md, AGENTS.md)
- Must follow from the spec

## Stage 4: Implement

Launch a builder subagent via `task` with fresh context. The builder:

- Creates or modifies code per the plan
- Writes unit and integration tests
- Follows all implementation conventions from `AGENTS.md`:
  - Package structure: `src/index.ts`, `src/<provider>-configuration.ts`, `src/<provider>-lock-provider.ts`, `__tests__/`
  - Peer dependencies: `@tslock/core` + canonical driver
  - Config: plain typed interface + `resolve<Provider>Configuration(input)`
  - Error handling: distinguish "lock not acquired" from "storage error"
  - ISO timestamps: `Utils.toIsoString(epochMillis)`
  - Tests: unit with mocked driver + integration with testcontainers/emulator + shared contract from `@tslock/test-support`
  - No comments in code
  - Dual format: tsup ESM + CJS
- Ensures the verification suite passes before handing off
- Check `docs/reviews/` for any known issues relevant to the provider/area being implemented

The builder must return: summary of files created/modified, test results, and any open issues.

## Stage 5: Verify

Run the full verification suite:

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r test:integration
pnpm -r build
```

Fix any failures. If substantial code changes were needed, re-run the full suite.

## Stage 6: Review

Launch an independent reviewer subagent via `task` with fresh context. The reviewer:

- Reads the spec, plan, architecture docs, and the implemented code
- Checks that the code matches the spec, the plan, and the architecture
- Checks for: correct error handling, missing edge cases, test coverage gaps, convention violations, review findings from `docs/reviews/` being addressed
- Produces `docs/reviews/<NN>-<name>.md`

The reviewer must return: the review document path and a summary of findings (pass/fail/needs-revision for each: spec alignment, plan alignment, architecture alignment, code quality, tests).

## Stage 7: Feedback loop

If the reviewer identifies discrepancies, send the work back to the lowest affected stage:

| Issue | Return to |
|---|---|
| Architecture mismatch | Block — requires user intervention (architecture is immutable otherwise) |
| Spec mismatch | Stage 2 (Spec) |
| Plan mismatch | Stage 3 (Plan) |
| Code or tests mismatch | Stage 4 (Implement) |
| Verification failing | Stage 5 (Verify) |
| Docs not updated | Stage 5 (Verify) or inline fix |

After the fix, cycle through Verify → Review again. Maximum 3 rounds before escalating to the user.

**Resolution hierarchy:** Architecture (immutable unless user says otherwise) > Spec > Plan > Code

## Stage 8: Documentation

Confirm that `README.md` and `AGENTS.md` were updated per the plan. If any doc change was missed, fix it.

## Stage 9: Done

Report completion: what was built, which providers/packages were created or modified, verification results, review outcome, and doc updates.

## Immutable docs rule

Specs, plans, and reviews in `docs/` are written once and not edited after the fact. New work gets new files. The only exception is an explicit maintainer decision. Do not backport changes into existing `docs/specs/`, `docs/plans/`, or `docs/reviews/`.
