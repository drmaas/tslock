---
name: 🔐 Pull Request
about: Open a pull request for TSLock
---

<!-- 🔐 Another lock acquired. Let's make sure it holds. -->
<!-- 👋 Thanks for contributing! Fill out what's relevant — we'll review fast. -->

## 📎 Linked issue

Closes #

## 🗺️ What this does

<!-- A clear summary of the change. What problem does it solve? How? -->

## 🏷️ Change type

<!-- Check the one that fits -->

- [ ] 🚀 `feat` — new feature / provider
- [ ] 🐛 `fix` — bug fix
- [ ] 📝 `docs` — documentation
- [ ] 🔧 `refactor` / `chore` / `test` / `ci` / `style`

## 🧩 Scope

<!-- Which package(s) are affected? e.g. core, redis, s3, test-support, etc. -->

## 🛡️ Verification checklist

<!-- The CI gate is the same one you run locally. Check each box. -->

### 🧹 Linting & formatting

- [ ] `pnpm check` passes (format + lint via Biome)

### 🏗️ Build

- [ ] `pnpm -r build` passes (tsup ESM + CJS + declarations)

### 🔍 TypeScript

- [ ] `pnpm -r typecheck` passes (`tsc --noEmit` across all packages)

### 🧪 Tests

- [ ] `pnpm -r test` passes (unit tests)
- [ ] `pnpm -r test:integration` passes (or confirmed no integration tests are expected for this change)

### 📦 Packaging

- [ ] `package.json` follows workspace conventions (peer deps, engines.node >= 22, dual format)
- [ ] No secrets, tokens, or keys in code

### 📚 Docs

- [ ] Package `README.md` updated (if public API changed)
- [ ] Main `README.md` updated (if adding a new provider or changing the matrix)
- [ ] Changeset added via `pnpm changeset` (for user-facing changes)
- [ ] Branch is up to date with `main`

### ✍️ Commits

- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] Every commit references an issue (`#<NN>` or `Closes #<NN>`)

## 🧠 Review notes

<!-- Anything the reviewer should pay special attention to? -->
<!-- Trade-offs, tricky edge cases, deferred items, known limitations? -->

## 📸 Screenshots / output

<!-- If the change is visual, or you want to show test output, paste it here. -->
