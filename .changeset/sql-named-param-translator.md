---
'@tslock/sql-support': minor
'@tslock/sql': patch
'@tslock/kysely': patch
'@tslock/drizzle': patch
---

Consolidate named-parameter translation in `@tslock/sql-support` and throw `LockException` for missing params across sql, kysely, and drizzle.
