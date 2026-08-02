---
name: tslock-doc-improver
description: Documentation-improvement workflow for TSLock. Use this skill whenever the user asks to improve, correct, reconcile, audit, or update documentation, READMEs, CONTRIBUTING.md, AGENTS.md, specs, plans, reviews, examples, links, commands, or API descriptions. Compare docs with specs, plans, reviews, and code; update docs and code only when necessary to restore an explicitly intended contract; verify and independently review, repeating until done. Do not use it for a feature, bug fix, or test-only change whose primary goal is elsewhere.
---

# TSLock Documentation Improver

Treat documentation as an executable contract for contributors and users. The goal is not merely smoother prose: it is accurate, navigable, internally consistent guidance that matches the repository's actual behavior and policies.

## 1. Establish the source of truth

- Read `CONTRIBUTING.md`, `AGENTS.md`, the relevant root/package README, and the requested docs.
- Locate related `docs/specs/`, `docs/plans/`, and `docs/reviews/` records, implementation files, tests, package metadata, scripts, and CI configuration.
- Build a small consistency map: claim → source document/code → current evidence → intended correction.
- Distinguish historical design records from current guidance. Specs, plans, and reviews are immutable after creation; do not edit them to make history appear consistent. Prefer correcting current docs or creating a new design record when a contract genuinely changes.
- Determine whether the requested change is actually a code bug or feature. If code behavior is wrong, route to `tslock-bugfix`; if behavior needs a new design, route to `tslock-sdd`.

## 2. Audit for quality and consistency

Check the relevant material for:

- inaccurate API names, package names, version requirements, counts, commands, paths, and links;
- contradictions between README, CONTRIBUTING, AGENTS, package docs, specs, plans, reviews, code, tests, and CI;
- examples that cannot compile or no longer reflect exports/configuration;
- missing prerequisites, integration-test caveats, environment variables, or failure semantics;
- unclear workflow routing, stale fast-track/full-workflow guidance, and missing when-not-to-use boundaries;
- unnecessary duplication that can be replaced with a precise link without hiding important context.

Do not make speculative claims. Verify commands and paths against the repository, and use tests or typechecking for examples when feasible.

## 3. Update deliberately

- Make the smallest coherent documentation change that fixes the identified inconsistency.
- Update all relevant current references in the same change so readers do not receive conflicting guidance.
- Preserve terminology and style already used by TSLock.
- If documentation reveals that code, tests, or metadata contradict an explicitly intended current contract, make the minimal corresponding code/test change only when it is clearly within scope; otherwise report the discrepancy and recommend the appropriate bugfix or SDD workflow.
- Never delete files or rewrite immutable historical design records without explicit permission.

## 4. Verify

Run targeted checks appropriate to the change:

```bash
pnpm check
```

Also verify changed Markdown links and referenced paths, command names, package exports, examples, and counts. Run package typechecks/tests when examples or behavior claims depend on them; run the broader suite when code or public API changed. Check that no stale references to renamed skills or commands remain.

## 5. Review and repeat

Request an independent review focused on factual accuracy, source-of-truth decisions, link/path validity, completeness across related docs, and whether any code change was justified. Fix findings, rerun verification, and review again until clean. Report the documents compared, files changed, checks run, and any intentionally preserved historical inconsistency.
