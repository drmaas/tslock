---
'@tslock/sql-support': patch
---

Bind a value for every `?` placeholder when a named parameter is repeated, so MySQL and SQLite queries keep the same number of placeholders and values. PostgreSQL `$n` placeholders still reuse one index per name.
