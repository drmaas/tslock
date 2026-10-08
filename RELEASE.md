# Releasing

Releases are **admin only**. Preferred path: GitHub Actions + npm trusted publishing (OIDC). No long-lived npm tokens in GitHub secrets. No direct pushes to `main` from the release bot.

All `@tslock/*` packages share one version (lockstep via Changesets `fixed: [["@tslock/*"]]`).

## Release via Actions

1. Merge PRs that include changesets (`pnpm changeset`) describing the intended bump.
2. GitHub → **Actions** → **Release** → **Run workflow**.
3. Choose `bump`: `patch` | `minor` | `major`.
4. Leave `force_changeset` false unless you need to force that bump (see below).
5. The workflow opens (or updates) a PR titled `chore: release vX.Y.Z` from branch `release/vX.Y.Z`. The release commit is created with GitHub's `createCommitOnBranch` API as `github-actions[bot]`. GitHub signs that commit, so the pull request can squash-merge under the `main` ruleset that requires verified signatures.
6. Wait for CI on that PR (it is dispatched explicitly — see below), review, then **squash-merge** into `main` keeping the `chore: release vX.Y.Z` title.
7. On push to `main`, the same `release.yml` publish job detects the release commit, publishes to npm over OIDC, creates tag `vX.Y.Z`, and creates a GitHub Release. Normal (non-release) pushes to `main` are a no-op.

`changeset publish` shells out to `pnpm publish`. The repo pins `packageManager: pnpm@12.10.1`, which natively exchanges GitHub OIDC tokens with npm (trusted publishing) and rewrites `workspace:` dependency ranges to concrete versions on pack/publish. The publish job does **not** use `actions/setup-node` `registry-url` or a long-lived `NODE_AUTH_TOKEN` / `NPM_TOKEN`.

Pushes and PRs created with `GITHUB_TOKEN` do not trigger other workflows. After opening the release PR, `release.yml` dispatches `ci.yml` via `workflow_dispatch` on `release/vX.Y.Z` so lockfile/verify/integration/pack still run. Main branch rulesets currently list **no** required status check contexts and have **no** tag rulesets (tag creation from the publish job is allowed).

| Intent | What to do |
| --- | --- |
| Normal release | Pending changesets already say `patch` / `minor` / `major`. Run the workflow with any `bump` and `force_changeset=false`. Changesets picks the highest bump in the fixed group; the `bump` input is advisory only. |
| Empty queue or forced bump | No pending changesets, or you want an explicit bump: set `bump` and either leave `force_changeset=false` (empty queue writes the bump) or set `force_changeset=true` to always write that bump. |
| Breaking API | Add a `major` changeset in a PR, **or** dispatch with `bump=major` and `force_changeset=true`. |

## One-time npm trusted-publisher setup (owner, local 2FA)

Packages must already exist on the npm registry. Run as the npm owner with a normal browser login (`npm login`). Granular tokens that bypass 2FA cannot run `npm trust`. Needs **Node ≥ 22.14** and **npm ≥ 11.15**.

```bash
npm install -g npm@^11.15.0
npm -v   # expect >= 11.15.0

# Preview
npx trustci --dry-run \
  --provider github \
  --repo drmaas/tslock \
  --file release.yml \
  --allow-publish

# Register (complete 2FA; optionally check skip 2FA for ~5 minutes)
npm login
npx trustci \
  --provider github \
  --repo drmaas/tslock \
  --file release.yml \
  --allow-publish
# add --env npm-publish if using a GitHub Environment gate
# add -y only after reviewing the dry-run output
```

`--file` is only the filename (`release.yml`), not `.github/workflows/release.yml`. If you pass `--env npm-publish`, uncomment `environment: npm-publish` on the **publish** job so the names match.

Verify / revoke:

```bash
npx trustci list
# or: npm trust list @tslock/core

npm trust list @tslock/core          # note the id
npm trust revoke @tslock/core --id <trust-id>
```

## Hardening (after a successful CI publish)

On npm package settings → Publishing access: **Require two-factor authentication and disallow tokens**. Do this only after OIDC publish works. Trusted publishing continues to work when tokens are disallowed.

## Emergency local publish

Use only if OIDC / Actions publish is broken. Still no committed tokens — interactive `npm login` / 2FA only. Prefer opening a normal release PR into `main` (branch rules block direct pushes):

```bash
pnpm login
pnpm changeset            # if needed
pnpm version-packages
pnpm format
pnpm check:packed-peers
git checkout -B release/v<version>
git add -A && git commit -m "chore: release v<version>"
git push -u origin HEAD
# open PR, squash-merge, then either let the publish job run or:
pnpm exec changeset publish
git tag v<version> && git push origin v<version>
```
