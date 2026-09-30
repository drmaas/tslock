---
'@tslock/cloudflare-kv': minor
---

Add `@tslock/cloudflare-kv`, an explicitly best-effort Workers KV lock provider. It uses ownership tokens and a 60-second minimum `expirationTtl`, and it does not provide mutual exclusion. Use `@tslock/cloudflare-do` when locks must not overlap.
