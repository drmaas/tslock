---
name: tslock-sdd
description: Spec-Driven Development workflow for substantial TSLock changes. Use this skill whenever the user asks to add a feature, add a provider, change a cross-package contract, introduce a new concept, perform an architectural or multi-file refactor, or explicitly asks for SDD, a spec, a plan, or the full TSLock development workflow. Do not use it for an isolated reproducible bug fix, a documentation-only improvement, or a test-only improvement unless the work reveals architectural scope; route those to tslock-bugfix, tslock-doc-improver, or tslock-test-improver instead.
---

# TSLock Spec-Driven Development

Use this workflow when the change needs a durable design decision before implementation. The purpose is to make the intended behavior, architecture, implementation order, verification, and review independently inspectable—not to create paperwork for a small patch.

## Operating principles

- Understand the repository before proposing a design. Treat `docs/00-vision.md`, `docs/01-architecture.md`, and the relevant existing spec, plan, and review as the architectural baseline.
- Preserve the repository's established patterns. Do not invent abstractions, provider categories, package relationships, or APIs without a reason grounded in the architecture.
- Keep specs, plans, and reviews immutable after creation. New work gets new files; never silently rewrite historical design records.
- Separate a lock-not-acquired result from a storage or programming error, and preserve the repository's testing and packaging conventions.
- Prefer the smallest design that fully addresses the requested scope. A full workflow does not justify unrelated cleanup.
- Do not commit, delete files, or make production changes outside the agreed scope unless the user explicitly asks.

## 0. Classify before editing

Choose the workflow before touching implementation files:

| Change | Skill/workflow |
|---|---|
| New feature, new provider, new concept, public API or cross-package contract, architectural change, or substantial refactor | This skill: full SDD |
| Isolated bug/regression with a clear reproduction and no new architecture | `tslock-bugfix` |
| Documentation consistency, accuracy, or usability improvement | `tslock-doc-improver` |
| Additional, corrected, or stronger test coverage without a feature change | `tslock-test-improver` |
| Tiny typo, formatting-only change, or other obvious one-line maintenance | Fast track; still run the narrowest meaningful verification |

A refactor belongs here when it affects multiple packages, public contracts, architecture, or requires a design decision. A local mechanical refactor can use fast track. If implementation reveals that the classification was wrong, stop and hand off to the appropriate workflow rather than forcing the current one.

## Foundation reading

Read these before writing a spec, in this order:

1. `docs/00-vision.md`
2. `docs/01-architecture.md`
3. `docs/specs/00-core.md`
4. `docs/plans/00-core.md`
5. `docs/reviews/00-core.md`
6. The relevant provider or subsystem's spec, plan, and review
7. `CONTRIBUTING.md` and `AGENTS.md` when the workflow or repository policy is relevant

Use focused searches and targeted reads for large documents. Do not assume a document is current merely because it exists: compare it with the implementation and recent repository conventions.

## Stage 1 — Interview and discovery

Before implementation, establish:

- the user outcome and explicit non-goals;
- affected packages, public APIs, provider category, and dependency boundaries;
- compatibility and migration expectations;
- lock lifecycle behavior: acquire, skip, unlock, extend, expiry, and failure handling;
- edge cases, concurrency behavior, and backend limitations;
- unit, integration, contract, fuzz, and documentation expectations;
- verification commands that are practical for the affected scope.

Ask focused questions when an answer would change the design. If the user delegates decisions, record the assumption and proceed. Inspect current code and tests before asking questions that repository evidence can answer.

## Stage 2 — Specification

Find the next unused two-digit `NN` shared by `docs/specs/`, `docs/plans/`, and `docs/reviews/`; check for collisions before creating files. Write `docs/specs/<NN>-<name>.md` with:

- problem, goals, non-goals, and compatibility impact;
- architecture fit and affected package/provider category;
- public API and configuration, including defaults and validation;
- behavior for acquire, lock-not-acquired, unlock, extend, expiry, concurrency, and errors;
- persistence, time, ownership, and retry semantics where relevant;
- unit, integration, shared-contract, fuzz, and documentation test expectations;
- unresolved decisions and explicit assumptions.

A spec describes behavior and invariants, not a speculative line-by-line implementation. Cross-check it against the architecture and existing provider patterns before proceeding.

## Stage 3 — Implementation plan

Write `docs/plans/<NN>-<name>.md` that follows from the spec. Include:

- ordered implementation steps with dependencies;
- exact files/packages to create or modify;
- tests to add or update and backend/emulator prerequisites;
- verification commands, including targeted checks and the full suite when appropriate;
- documentation, README, changeset, and contributor-guide updates;
- rollback or compatibility considerations and likely review risks.

The plan must be actionable by a fresh implementer. If the plan and spec disagree, resolve that before coding rather than letting code become the accidental source of truth.

## Stage 4 — Implementation

Use a fresh builder context when the environment supports subagents. Give it the spec, plan, relevant architecture docs, known review findings, and explicit verification expectations. The implementation must:

- follow the package structure, peer dependency, dual ESM/CJS, strict TypeScript, and no-unrequested-abstractions conventions in `AGENTS.md`;
- add or update unit and integration tests, using `@tslock/test-support` contracts where applicable;
- distinguish expected contention from real errors;
- avoid editing historical specs, plans, or reviews;
- update user-facing docs and changesets when the plan calls for them.

Return a concise file summary, test results, assumptions, and open issues before review.

## Stage 5 — Verification

Run the narrowest useful checks first, then the repository gates required by the scope. The standard suite is:

```bash
pnpm check
pnpm -r typecheck
pnpm -r test
pnpm test:integration
pnpm -r build
pnpm check:packed-peers
```

Integration tests may require Docker or opt-in services; record skipped prerequisites explicitly rather than treating them as passing. Fix failures, rerun affected checks, and rerun broader checks after substantial changes. Verify links, generated artifacts, package exports, and docs when they are in scope.

## Stage 6 — Independent review

Request an independent reviewer with fresh context. It should read the spec, plan, architecture, implementation, tests, and relevant historical reviews, then check:

- spec, plan, and architecture alignment;
- API and compatibility correctness;
- concurrency, ownership, time, and error edge cases;
- test quality and meaningful coverage;
- package/build/lint conventions;
- documentation and changeset completeness.

Create `docs/reviews/<NN>-<name>.md` with findings, severity, evidence, verification status, and a clear outcome: pass, needs revision, or blocked. Do not edit the spec or plan to hide a mismatch.

## Stage 7 — Feedback loop

Repeat verification and independent review until the change is done. Route findings to the lowest affected stage:

| Finding | Return to |
|---|---|
| Architecture conflict | Block and ask the maintainer; architecture is not changed implicitly |
| Spec ambiguity or mismatch | Stage 2; create a new design record if the historical record must remain immutable |
| Plan gap | Stage 3 |
| Code or test defect | Stage 4 |
| Verification failure | Stage 5 |
| Missing docs or changeset | Stage 5 and documentation updates |

Use at most three focused review rounds before escalating a persistent disagreement or environmental blocker. A reviewer finding is not complete until the fix is verified and the reviewer (or an equivalent fresh review) confirms it.

## Stage 8 — Documentation and handoff

Confirm that the implementation, package README(s), root `README.md`, `CONTRIBUTING.md`, and `AGENTS.md` are consistent with the completed change where applicable. Confirm changesets for user-facing package changes. Report:

- what changed and why;
- spec, plan, and review paths;
- files/packages affected;
- verification commands and results, including environmental skips;
- review outcome and any deferred work.

Do not commit unless explicitly asked.
