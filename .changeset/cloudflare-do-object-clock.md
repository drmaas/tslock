---
'@tslock/cloudflare-do': patch
---

Derive Durable Object lock deadlines from the object clock. Acquire, unlock, and extend compute `lockUntil` and `lockAtLeastUntil` from `Date.now()` plus the request durations. Non-finite durations, negative durations, and a minimum hold longer than the maximum are rejected with HTTP 400. The request body shape is unchanged.
