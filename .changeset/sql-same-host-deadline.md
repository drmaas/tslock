---

'@tslock/sql-support': patch
'@tslock/sql': patch
'@tslock/kysely': patch
'@tslock/drizzle': patch
---

Ignore a stale unlock or extend after another process on the same host reacquires a SQL lock. Unlock and extend now require the stored deadline to match this acquisition. SQL Server date parameters are bound as `datetime2` so that equality matches `datetime2` columns.
