---
"@tslock/test-support": patch
"@tslock/in-memory": patch
---

Document clock-skew and related failure modes, and add an in-memory harness (`MutableClock` / `withMutableClock`) that asserts documented double-execution scenarios without claiming stronger guarantees than the time-based lock model.
