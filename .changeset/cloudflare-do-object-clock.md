---
'@tslock/cloudflare-do': patch
---

Derive Durable Object lock deadlines from the object clock. Acquire and extend set `lockUntil` from `Date.now()` plus `lockAtMostFor`. Acquire stores `lockAtLeastUntil` from that clock plus `lockAtLeastFor`, and extend only moves that minimum forward. Unlock uses the stored minimum instead of the request clock. Non-finite durations, negative durations, and a minimum hold longer than the maximum are rejected with HTTP 400. The request body shape is unchanged.
