# Review: Versioning & Publishing

## Scope

This review covers `docs/specs/23-publishing.md` and `docs/plans/23-publishing.md`, including Changesets configuration, lockstep package versioning, package publish metadata, and the local release workflow.

## Findings

- `.changeset/config.json` uses fixed mode for `@tslock/*`, preserving compatible lockstep versions across the published packages.
- Published package manifests provide public publish configuration, repository metadata, dual ESM/CJS exports, `sideEffects: false`, and a `./package.json` export.
- The root release script runs static checks, builds, unit tests, and packed-peer verification before `changeset publish`.
- `scripts/check-packed-peers.mjs` verifies packed peer dependencies without relying on unresolved `workspace:*` ranges and uses pnpm 11-compatible pack arguments.
- Publishing remains local and interactive, preserving npm 2FA requirements; no credentials or publish tokens are introduced into CI.

## Validation

- Packed-peer verification passes for all `@tslock/*` packages.
- Package metadata assertions pass for all 33 workspace packages.
- Full workspace typecheck, unit tests, and build pass.
- Production dependency audit reports no known vulnerabilities.

## Decision

**Approved.** The publishing configuration and release gate are consistent with the fixed-version strategy and prevent unresolved workspace peer ranges from reaching npm.
