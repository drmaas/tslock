# Implementation Plan: Native Build Policy

## Scope

Implement the approved `docs/specs/26-native-build-policy.md` without changing published runtime behavior.

## Steps

1. Set `cpu-features: false` and `ssh2: false` in `pnpm-workspace.yaml` so pnpm 11 treats the optional native install scripts as intentionally denied.
2. Externalize `vitest` from `@tslock/test-support`'s tsup bundle and declare `vitest` as a peer dependency. The shared integration contracts import Vitest APIs and must execute against the consuming test runner's singleton rather than a bundled second runtime.
3. Document the default native-build policy, local Docker-socket behavior, and the deliberate Docker-over-SSH override in `README.md`, `CONTRIBUTING.md`, and `AGENTS.md`.
4. Add the corresponding changeset and follow-up review record.

## Verification

- `pnpm install --frozen-lockfile`
- rebuild `@tslock/test-support` and `@tslock/in-memory`
- `pnpm --filter @tslock/in-memory test:integration`
- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm audit --prod`
- independent code review

External-service integration suites remain environment-dependent and are reported separately.
