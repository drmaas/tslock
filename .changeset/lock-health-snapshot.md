---
"@tslock/core": minor
---

Add a read-only lock health snapshot (`createLockHealthMonitor`) on top of `TrackingLockProviderWrapper` for ops introspection (active locks, last acquire/skip, keep-alive failures, overdue leases).
