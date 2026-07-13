# Implementation Plan: Versioning & Publishing

## Overview

Set up Changesets for the TSLock monorepo: lockstep versioning across all `@tslock/*` packages, documented local publish workflow (npm 2FA is handled interactively), and a CI verification workflow that runs `check → typecheck → test → build` on every push and PR. No CI publish — only verification.

## Prerequisites

- All 25 packages implemented, building, and passing tests (✅ done)
- npm account with publish rights to the `@tslock` scope (or ownership to create it)
- Node 20+, pnpm 10+ via corepack

## Steps

### Step 1: Install Changesets dependencies

```bash
pnpm add -D -w @changesets/cli @changesets/changelog-github
```

### Step 2: Initialize Changesets

```bash
pnpm changeset init
```

Creates `.changeset/config.json` (edit in Step 3) and `.changeset/README.md`.

### Step 3: Configure `.changeset/config.json`

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

Key settings: `"fixed"` for lockstep, `"access": "public"` for scoped packages.

### Step 4: Add root scripts

In `package.json`:

```json
"scripts": {
  "typecheck": "pnpm -r typecheck",
  "test": "pnpm -r test",
  "build": "pnpm -r build",
  "changeset": "changeset",
  "version-packages": "changeset version",
  "release": "pnpm check && pnpm build && pnpm test && changeset publish"
}
```

### Step 5: Add `publishConfig` + `repository` to all packages

Script to update all 25+ packages:

```bash
node -e "
const fs = require('fs');
const baseUrl = 'git+https://github.com/drmaas/tslock.git';
for (const dir of fs.readdirSync('packages').filter(f => fs.statSync('packages/'+f).isDirectory())) {
  const p = JSON.parse(fs.readFileSync('packages/'+dir+'/package.json','utf8'));
  p.publishConfig = { access: 'public' };
  p.repository = { type: 'git', url: baseUrl, directory: 'packages/'+dir };
  fs.writeFileSync('packages/'+dir+'/package.json', JSON.stringify(p, null, 2) + '\n');
}
"
```

### Step 6: Create CI workflow

**File:** `.github/workflows/ci.yml`

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
      - run: pnpm check
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

### Step 7: Delete stale release workflow (if present)

```bash
rm .github/workflows/release.yml
```

### Step 8: Verify

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

All must pass with zero errors. Dry-run publish to verify packaging:

```bash
pnpm -r publish --dry-run --no-git-checks
```

### Step 9: Create the first changeset and release

```bash
pnpm changeset
# Select all packages, choose major/minor/patch, write summary

pnpm version-packages
git add -A && git commit -m "chore: release v<version>"
pnpm publish -r         # handles 2FA interactively via pnpm login session
git tag v<version> && git push --follow-tags
```

## Local Publish Workflow (for day-to-day use)

```bash
pnpm login                                       # one-time — handles 2FA
pnpm changeset                                   # describe changes, pick semver bump
pnpm version-packages                            # bump versions + changelogs
git add -A && git commit -m "chore: release v<version>"
pnpm publish -r                                  # publish all packages
git tag v<version> && git push --follow-tags     # tag + push
```

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `pnpm publish -r` fails with `workspace:*` not resolved | `changeset version` in Step 3 replaces `workspace:*` with `^x.y.z` in the version commit. Verify by checking `git diff` after `version-packages`. |
| Scoped package publish fails as private | `publishConfig.access: "public"` on every package (Step 5). |
| Forgot `pnpm login` before publish | `pnpm publish -r` fails with `ENEEDAUTH` — run `pnpm login` and retry. |
| CI `pnpm test` slow (500+ tests) | Acceptable for a gate. Run in CI in parallel. Not a blocking concern for correctness. |
| `@changesets/changelog-github` requires `GITHUB_TOKEN` | CI workflow provides it automatically via `${{ secrets.GITHUB_TOKEN }}`. |

## Estimation

~1 hour for first-time setup including the initial release.

## Order of Implementation

1. Install deps + `changeset init` (Steps 1-2)
2. Edit config + scripts (Steps 3-4)
3. Update all package.json files (Step 5)
4. Create CI workflow + delete stale release workflow (Steps 6-7)
5. Verify (Step 8)
6. First release (Step 9)
