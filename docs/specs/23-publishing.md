# Spec: Versioning & Publishing

## Overview

TSLock uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing all `@tslock/*` packages to npm. Publishing is done **locally** (npm 2FA is handled interactively via `npm login`). CI runs verification (check, typecheck, test, build) on every push and PR.

**Refinement of vision §10:** The vision doc states "Provider packages follow their own semver but track core's major." After analysis, this is impractical to enforce automatically and noisy at 25+ packages. This spec adopts **lockstep (fixed) versioning**: all `@tslock/*` packages share a single version number, bumped together on every release. Rationale in §Versioning Strategy below.

## Package

| Field | Value |
|---|---|
| **Tool** | `@changesets/cli` (root devDependency) |
| **Strategy** | Lockstep (fixed) — all `@tslock/*` packages share one version |
| **Registry** | npm (public scoped packages) |
| **Publish method** | Local (`pnpm publish -r`) |
| **CI verification** | `pnpm check && pnpm typecheck && pnpm test && pnpm build` |
| **Changelog** | `@changesets/changelog-github` (PR-linked entries) |

## Versioning Strategy

### Lockstep (Fixed Mode)

All `@tslock/*` packages are grouped in `"fixed": [["@tslock/*"]]` in `.changeset/config.json`. A release bumps every package in the group to the same version number.

**Why lockstep over independent (multi-semantic-release):**

| Concern | Lockstep | Independent |
|---|---|---|
| User clarity | `@tslock/core@1.2.0` + `@tslock/redis@1.2.0` always compatible | User must verify peer-dep ranges per upgrade |
| Release cost | One release command bumps all 25+ packages | Only changed packages bump (25+ changelogs) |
| Tooling | Simple (changesets fixed mode) | Complex (multi-semantic-release or changesets independent) |
| Impact of bugfix | All packages bump even for a single-provider fix | Only the fixed provider bumps |
| Cosmetic waste | Unchanged packages get a new version (invisible — users install only what they need) | None |

The "cosmetic waste" of bumping all packages is **zero-cost in practice**: users install only the packages they need (`pnpm add @tslock/core @tslock/redis`); the version numbers of packages they don't install are invisible. The clarity benefit — every `@tslock/*` package at the same version is guaranteed compatible — outweighs the cosmetic cost.

### Semver Rules

- **Patch (1.0.x)**: bug fixes, no API changes.
- **Minor (1.x.0)**: new providers, new features, backward-compatible API additions.
- **Major (x.0.0)**: breaking API changes to `@tslock/core` or any provider's public config interface.

### Pre-1.0

All packages ship at `1.0.0` for the initial release. Changesets treats 0.x versions specially (major bumps become minor) — we skip this by starting at 1.0.0.

## Release Workflow

All releases are performed **locally** — CI does not publish to npm because npm 2FA (required for the `@tslock` scope) is interactive and cannot be automated via tokens.

### Local Publish (validated workflow)

```bash
# 1. Authenticate with npm (handles 2FA interactively)
pnpm login

# 2. Create a changeset — select all packages, pick major/minor/patch, write summary
pnpm changeset

# 3. Consume changeset files — bumps all @tslock/* versions, updates CHANGELOGs
pnpm version-packages

# 4. Review the diff
git diff

# 5. Commit the version bump
git add -A && git commit -m "chore: release v<version>"

# 6. Publish all packages to npm
pnpm publish -r

# 7. Tag and push
git tag v<version> && git push --follow-tags
```

Step 6 (`pnpm publish -r`) publishes every `@tslock/*` package to npm under the same version. Because packages use `files: ["dist"]` in their `package.json` and `tsup clean: true`, only the built artifacts are published.

## Verification (CI)

On every push to any branch and on every pull request to `main`, GitHub Actions runs the full verification suite:

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable && pnpm install
        env:
          CI: true
      - run: pnpm check      # Biome format + lint
      - run: pnpm typecheck   # tsc --noEmit across all packages
      - run: pnpm test        # vitest run across all packages
      - run: pnpm build       # tsup across all packages
```

This catches formatting issues, type errors, test failures, and build breaks before they reach `main`.

## Configuration

### `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "drmaas/tslock" }],
  "commit": false,
  "fixed": [["@tslock/*"]],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

Key settings:
- `"fixed": [["@tslock/*"]]` — all `@tslock/*` packages share one version (lockstep).
- `"access": "public"` — scoped packages on npm default to private; must be public.
- `"changelog": ["@changesets/changelog-github", { "repo": "drmaas/tslock" }]` — changelogs include GitHub PR links.
- `"baseBranch": "main"` — changesets evaluates changes relative to `main`.
- `"commit": false` — changesets does not auto-commit.
- `"updateInternalDependencies": "patch"` — when a dependency changes, dependents get at least a patch bump (moot under lockstep — all bump together).

### Root `package.json`

```json
{
  "name": "tslock",
  "private": true,
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "pnpm check && pnpm build && pnpm test && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.31.0",
    "@changesets/changelog-github": "^0.7.0"
  }
}
```

Scripts:
- `changeset` — interactive changeset creation.
- `version-packages` — `changeset version` (bump versions + changelogs).
- `release` — local convenience: `check + build + test + publish`.

### Per-package `package.json` (all 25+)

Each `packages/*/package.json` has:

```json
{
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/drmaas/tslock.git",
    "directory": "packages/<name>"
  }
}
```

- `publishConfig.access: "public"` — required for scoped packages; npm defaults scoped to private.
- `repository` — enables npm links to the repo subdirectory.

The root `package.json` stays `"private": true` — the monorepo root is never published.

## File Structure

```
tslock/
├── .changeset/
│   ├── config.json          # changesets config (fixed mode)
│   └── README.md            # generated by changeset init
├── .github/
│   └── workflows/
│       └── ci.yml           # CI verification (check, typecheck, test, build)
├── package.json             # root — changeset scripts + devDeps
└── packages/*/
    └── package.json         # each — publishConfig + repository
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| `pnpm login` not yet run | `pnpm publish -r` fails with `ENEEDAUTH` — run `pnpm login` first |
| npm 2FA challenge during publish | Handled interactively via `pnpm login` session — no token-based auth |
| `pnpm check` fails in CI | CI workflow fails; push/PR is blocked |
| `pnpm typecheck` fails in CI | CI workflow fails; push/PR is blocked |
| `pnpm test` failures in CI | CI workflow fails; push/PR is blocked |
| `pnpm build` failures in CI | CI workflow fails; push/PR is blocked |
| Changeset file has invalid frontmatter | `changeset version` fails with a parse error |
| Package already published at target version | `pnpm publish -r` skips it (no-op) |
| Wrong version bump applied | Amend the commit or revert and recreate the changeset |

## Non-Goals (for this spec)

- No CI publish — all publishing is local due to npm 2FA requirements.
- No automatic git tagging — the user tags manually as part of the local publish workflow.
- No npm provenance / sigstore signing — can be added later.
- No beta/alpha channel — all releases go to the `latest` tag.
- No independent versioning — explicitly rejected in favor of lockstep (see Versioning Strategy).
