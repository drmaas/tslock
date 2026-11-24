---
---

Fail `pnpm validate:lockfile` when a workspace override key has an empty semver range after the final `@` (for example `qs@@` or `undici@^6@`).