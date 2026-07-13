# Spec: Versioning & Publishing

## Overview

TSLock uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing all `@tslock/*` packages to npm. This spec defines the versioning strategy, release workflow (local and CI), and the configuration required to publish a 25+ package pnpm-workspace monorepo as public scoped npm packages.

**Refinement of vision §10:** The vision doc states "Provider packages follow their own semver but track core's major." After analysis, this is impractical to enforce automatically and noisy at 25+ packages. This spec adopts **lockstep (fixed) versioning**: all `@tslock/*` packages share a single version number, bumped together on every release. Rationale in §Versioning Strategy below.

## Package

| Field | Value |
|---|---|
| **Tool** | `@changesets/cli` (root devDependency) |
| **Strategy** | Lockstep (fixed) — all `@tslock/*` packages share one version |
| **Registry** | npm (public scoped packages) |
| **Local publish** | `pnpm release` |
| **CI publish** | `changesets/action@v1` on push to `main` |
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

### Local Publish

```bash
# 1. Describe the change (interactive — select packages + semver bump + summary)
pnpm changeset

# 2. Consume changeset files, bump all @tslock/* to the same version, update CHANGELOGs
pnpm version-packages

# 3. Review the diff (package.json version bumps + CHANGELOG.md updates)
git diff

# 4. Build, test, and publish to npm
pnpm release

# 5. Commit the version bump and tag
git add -A
git commit -m "chore: release v$(node -p "require('./packages/core/package.json').version")"
git tag "v$(node -p "require('./packages/core/package.json').version")"
git push --follow-tags
```

The `pnpm release` script runs `pnpm test && pnpm build && changeset publish`. Publishing requires `npm login` to have been run (or `NPM_TOKEN` set in `.npmrc` for CI).

### CI Publish (GitHub Actions)

On every push to `main`, the `changesets/action`:

1. **If unreleased changeset files exist** — creates/updates a "Version Packages" PR that bumps versions and updates CHANGELOGs.
2. **If the Version Packages PR was just merged** (no unreleased changesets, version bump in package.json) — runs `pnpm release` to build, test, and publish to npm.

The Version Packages PR is the gate: a human reviews the version bump and changelog before merging, which triggers the publish.

## Configuration

### `.changeset/config.json`

Created by `changeset init`, then edited:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": "@changesets/changelog-github",
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
- `"changelog": "@changesets/changelog-github"` — changelogs include GitHub PR links (requires `GITHUB_TOKEN`).
- `"baseBranch": "main"` — changesets evaluates changes relative to `main`.
- `"commit": false` — changesets does not auto-commit; the `changesets/action` handles commits in CI.
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
    "release": "pnpm test && pnpm build && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.28.0",
    "@changesets/changelog-github": "^0.5.0",
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

Three new scripts:
- `changeset` — interactive changeset creation.
- `version-packages` — `changeset version` (bump versions + changelogs).
- `release` — `test + build + changeset publish`.

Two new devDeps:
- `@changesets/cli` — the tool.
- `@changesets/changelog-github` — PR-linked changelogs.

### Per-package `package.json` (all 25)

Each `packages/*/package.json` needs two additions:

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
- `repository` — npm listing quality; enables "homepage" and "bugs" links on the npm page; points to the subdirectory in the monorepo.

The root `package.json` stays `"private": true` — the monorepo root is never published.

## File Structure

```
tslock/
├── .changeset/
│   ├── config.json          # changesets config (fixed mode)
│   └── README.md            # generated by changeset init — explains the workflow
├── .github/
│   └── workflows/
│       └── release.yml      # changesets/action for CI versioning + publishing
├── package.json             # root — adds changeset scripts + devDeps
└── packages/*/
    └── package.json         # each — adds publishConfig + repository
```

## GitHub Actions Workflow

**File:** `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
      - run: corepack enable && pnpm install
      - uses: changesets/action@v1
        with:
          publish: pnpm release
          commit: 'chore: version packages'
          title: 'chore: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
```

Notes:
- `fetch-depth: 0` — changesets needs full git history to compute changes since the last release.
- `registry-url` — configures `.npmrc` with the npm registry for `pnpm publish`.
- `corepack enable && pnpm install` — enables pnpm via corepack, installs all workspace deps.
- `GITHUB_REPOSITORY` env — required by `@changesets/changelog-github` to generate PR links (format: `owner/repo`).
- `NPM_TOKEN` — npm auth token; must be set in the GitHub repo's secrets.
- `GITHUB_TOKEN` — automatically provided by GitHub Actions; used for creating the Version Packages PR.

## Secrets Required

| Secret | Where | Purpose |
|---|---|---|
| `NPM_TOKEN` | GitHub repo settings → Secrets | `npm publish` authentication |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions | Creating the Version Packages PR |

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Local publish without `npm login` | `npm publish` fails with `ENEEDAUTH` — run `npm login` first |
| CI publish without `NPM_TOKEN` secret | `changeset publish` fails with auth error — add `NPM_TOKEN` to repo secrets |
| CI publish without `GITHUB_TOKEN` permission | Action fails to create Version PR — ensure `permissions: pull-requests: write` is set |
| Package already at target version | `changeset publish` skips it (no-op) |
| `pnpm test` fails before publish | `pnpm release` exits non-zero; publish does not run |
| `pnpm build` fails before publish | `changeset publish` runs on stale dist or fails — `pnpm release` exits non-zero |
| Changeset file has invalid frontmatter | `changeset version` fails with a parse error |
| Version PR already open for the same changesets | Action updates the existing PR (no duplicate) |

## Non-Goals (for this spec)

- No automatic git tagging on local publish — the user runs `git tag` manually (CI handles tags via `changeset publish`).
- No npm provenance / sigstore signing — can be added later via `npm publish --provenance` in the workflow.
- No beta/alpha channel — all releases go to the `latest` tag. Pre-release channels can be added via changesets' `pre` mode if needed.
- No automatic GitHub Release creation — the Version Packages PR serves as the release record. A `gh release create` step can be added later.
- No independent versioning — explicitly rejected in favor of lockstep (see Versioning Strategy).
