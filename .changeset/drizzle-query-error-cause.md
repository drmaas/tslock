---
'@tslock/drizzle': patch
---

Recognize duplicate-key errors wrapped in drizzle-orm's `DrizzleQueryError` (driver error on `.cause`) so MySQL/SQLite `lock()` returns false instead of throwing once the shedlock row exists.
