# Review: Native Build Policy Follow-up

## Scope

This follow-up verifies the workspace install policy introduced during the architecture-hardening work. The policy explicitly denies the optional install scripts for transitive `cpu-features` and `ssh2` dependencies of testcontainers.

## Findings

- `pnpm-workspace.yaml` uses boolean `false` entries for both packages; no unresolved placeholder values remain.
- `pnpm install --frozen-lockfile` completes successfully under pnpm 11.14.0 without `ERR_PNPM_IGNORED_BUILDS`.
- Standard testcontainers usage through the local Docker socket does not require Docker-over-SSH support, so the default deny policy is appropriate for CI and ordinary local integration tests.
- Docker-over-SSH is explicitly unsupported under the default policy. Developers who need it locally must deliberately set both entries to `true`, reinstall, and provide the native build toolchain; that local override must not be committed unintentionally.
- README, CONTRIBUTING.md, and AGENTS.md describe the policy and its limitation.

## Decision

**Approved.** The explicit deny policy makes installation deterministic without weakening the repository's default supply-chain posture. Full repository verification follows this document; provider integrations that require external services remain environment-dependent.
