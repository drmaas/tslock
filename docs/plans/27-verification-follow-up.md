# Implementation Plan: Verification Follow-up

## Scope

Implement `docs/specs/27-verification-follow-up.md` as a focused correction to shared test-support execution and release verification.

## Steps

1. Externalize `vitest` from `@tslock/test-support` and declare it as a peer so shared contracts use the consuming runner singleton.
2. Mark extensible and storage-based contract wrappers as extensible and make mock-clock advancement stable between explicit advances.
3. Remove the unsupported `--ignore-scripts` option from the pnpm pack checker and retain useful stderr diagnostics.
4. Update contributor documentation, changeset scope, and verification records.

## Verification

- `pnpm install --frozen-lockfile`
- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm test:integration`
- `pnpm check:packed-peers`
- `pnpm audit --prod`
- independent review

External service availability is recorded separately from source/test failures.
