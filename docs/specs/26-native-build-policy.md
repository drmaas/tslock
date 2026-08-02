# Spec: Native Build Policy

## Overview

This follow-up specifies the workspace install policy for optional native install scripts pulled in transitively by testcontainers. It is a narrow tooling and contributor-experience change following the architecture-hardening work.

## Requirements

- `pnpm-workspace.yaml` must use explicit boolean values for `cpu-features` and `ssh2` under `allowBuilds`.
- The default policy must deny both optional install scripts so `pnpm install --frozen-lockfile` is deterministic on supported Node.js environments and CI.
- Documentation must explain that ordinary local Docker-socket testcontainers usage does not require these optional builds.
- Documentation must state that Docker-over-SSH is outside the default support policy and explain the deliberate local override (`true` for both entries, reinstall, native toolchain) without encouraging accidental commits.
- The policy must not alter published runtime package dependencies.

## Verification

- Frozen install completes without `ERR_PNPM_IGNORED_BUILDS`.
- Repository static checks, typechecks, unit tests, and builds remain green.
- Production dependency audit remains clean.
- Integration-test failures are classified separately when external services or test wiring are unavailable.
