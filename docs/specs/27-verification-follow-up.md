# Spec: Verification Follow-up

## Overview

This follow-up records the verification requirements discovered after implementing the architecture-hardening and native-build-policy work. It covers shared test-support execution, release packaging, and final evidence without changing runtime API contracts.

## Requirements

- Shared integration contracts must execute against the consuming Vitest runtime; test-support bundles must not include a second Vitest implementation.
- Extensible and storage-based provider contract wrappers must not run the generic non-extensible-provider assertion.
- Mock-clock contract tests must advance time explicitly and return a stable timestamp between advances.
- The packed-peer release gate must pack every published `@tslock/*` package and inspect its packed manifest for unresolved `workspace:*` peer ranges while preserving useful diagnostics on failure.
- Verification records must distinguish source/test failures from unavailable external services.

## Acceptance criteria

- In-memory and PostgreSQL integration contracts pass.
- Repository check, typecheck, unit tests, build, audit, and packed-peer verification pass.
- Any unavailable provider service is documented as an environment limitation rather than silently treated as a source failure.
