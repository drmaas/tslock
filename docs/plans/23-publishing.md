# Implementation Plan: Versioning & Publishing

## Overview

Set up Changesets for the TSLock monorepo: lockstep versioning across all 25 `@tslock/*` packages, local + CI publish to npm, and a GitHub Actions workflow that automates the version-bump PR and publish step. No application code changes — only tooling, package.json metadata, and CI config.

## Prerequisites

- All 25 packages implemented, building, and passing tests (✅ done)
- npm account with publish rights to the `@tslock` scope (or ownership to create it)
- GitHub repo `drmaas/tslock` with access to Settings → Secrets
- Node 20+, pnpm 10+ via corepack

## Steps

### Step 1: Install Changesets dependencies

At the workspace root:

```bash
pnpm add -D -w @changesets/cli @changesets/changelog-github
```

This adds to root `package.json` `devDependencies`:
- `@changesets/cli` (^2.28.0)
- `@changesets/changelog-github` (^0.5.0)

### Step 2: Initialize Changesets

```bash
pnpm changeset init
```

Creates `.changeset/` directory with:
- `config.json` — default config (to be edited in Step 3)
- `README.md` — explains the changeset workflow

### Step 3: Configure `.changeset/config.json`

Replace the generated config with:

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

Key differences from the default:
- `"changelog"`: `@changesets/changelog-github` (not the default `@changesets/cli/changelog`)
- `"fixed": [["@tslock/*"]]`: lockstep mode (not empty)
- `"commit": false`: don't auto-commit (CI handles commits)
- `"access": "public"`: scoped packages must be public

### Step 4: Add root scripts

Edit root `package.json` `scripts` to add three scripts:

```json
"changeset": "changeset",
"version-packages": "changeset version",
"release": "pnpm test && pnpm build && changeset publish"
```

### Step 5: Add `publishConfig` + `repository` to all 25 packages

For each `packages/*/package.json`, add two fields. The `repository.directory` differs per package.

A script to apply this to all packages:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const baseUrl = 'git+https://github.com/drmaas/tslock.git';
const packages = fs.readdirSync('packages').filter(f => fs.statSync('packages/' + f).isDirectory());
for (const dir of packages) {
  const pkgPath = 'packages/' + dir + '/package.json';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.publishConfig = { access: 'public' };
  pkg.repository = { type: 'git', url: baseUrl, directory: 'packages/' + dir };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('Updated ' + pkgPath);
}
"
```

### Step 6: Create `.github/workflows/release.yml`

Create the directory and file:

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
          node-version: 22
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

### Step 7: Add `NPM_TOKEN` to GitHub secrets

Manual step (cannot be automated):
1. Generate an npm access token with `publish` scope at https://www.npmjs.com/settings/drmaas/tokens
2. In the GitHub repo: Settings → Secrets and variables → Actions → New repository secret
3. Name: `NPM_TOKEN`, Value: the token

### Step 8: Verify local publish (dry run)

```bash
# Verify the build + test pipeline works end-to-end
pnpm test && pnpm build

# Dry-run publish (no actual publish) to verify package contents
pnpm -r publish --dry-run --no-git-checks
```

Check that each package's tarball includes only `dist/` (from `files: ["dist"]`), not `src/` or `__tests__/`.

### Step 9: Create the first changeset and test the workflow

```bash
# Create a changeset describing the initial release
pnpm changeset
# Select all packages, choose "minor" (1.0.0 → 1.1.0), summary: "Initial public release"

# Consume the changeset — bumps versions + updates CHANGELOGs
pnpm version-packages

# Review the diff
git diff

# Verify the build still works with new versions
pnpm build
```

### Step 10: Verify CI workflow (after push)

After committing the changeset and pushing to `main`:
1. The `Release` workflow runs.
2. `changesets/action` detects the unreleased changeset file.
3. A "Version Packages" PR is created automatically.
4. Review the PR — it bumps all 25 `package.json` versions and adds `CHANGELOG.md` entries.
5. Merge the PR.
6. The `Release` workflow runs again — this time `changesets/action` detects no unreleased changesets and runs `pnpm release` (test + build + publish).
7. All 25 packages are published to npm.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `pnpm publish` fails with `workspace:*` not resolved | `changeset publish` runs `pnpm publish` which resolves `workspace:*` to `^x.y.z` at publish time. Verified by `--dry-run` in Step 8. |
| Scoped package publish fails as private | `publishConfig.access: "public"` on every package (Step 5). npm defaults scoped to private; this overrides. |
| `@changesets/changelog-github` fails without `GITHUB_REPOSITORY` | Set `GITHUB_REPOSITORY: ${{ github.repository }}` in the workflow env (Step 6). |
| 25 git tags per release is noisy | Acceptable — tags are lightweight. If too noisy, add `"git-tag": false` to changeset config and tag manually. |
| Version PR has conflicts with concurrent changes | `changesets/action` force-updates the PR on each push to main. Conflicts are auto-resolved by re-running `changeset version`. |
| `NPM_TOKEN` expires or is revoked | Monitor via the workflow failing on publish. Rotate the token. Document in the README. |
| Local publish publishes stale dist | `pnpm release` runs `pnpm build` before `changeset publish`. `tsup` config has `clean: true` so dist is rebuilt. |
| `pnpm test` in release is slow (509 tests) | Acceptable for a release gate. Can be split into `unit` (fast) + `integration` (slow) if needed — but the full suite is the safety net. |
| First publish to `@tslock` scope fails (scope doesn't exist) | Create the `@tslock` org on npm first, or publish `@tslock/core` manually to claim the scope. |
| Changeset files accumulate in `.changeset/` | `changeset version` consumes them (deletes the `.md` files, moves content to CHANGELOGs). The Version PR cleans them up. |

## Estimation

~3 files created (`.changeset/config.json`, `.changeset/README.md`, `.github/workflows/release.yml`), 1 file edited (root `package.json`), 25 files edited (per-package `package.json`). ~30-45 minutes including the first end-to-end test.

## Order of Implementation

1. Install deps (Step 1)
2. `changeset init` (Step 2)
3. Edit `.changeset/config.json` (Step 3)
4. Edit root `package.json` scripts (Step 4)
5. Edit all 25 package.json files (Step 5)
6. Create GitHub Actions workflow (Step 6)
7. Add `NPM_TOKEN` secret (Step 7 — manual)
8. Dry-run verify (Step 8)
9. Create first changeset + version (Step 9)
10. Push + verify CI (Step 10)
