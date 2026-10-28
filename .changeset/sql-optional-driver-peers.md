---
'@tslock/sql': patch
---

Declare `pg`, `mysql2`, `mssql`, `@types/pg`, and `@types/mssql` as optional peer dependencies, and type SQL pools structurally so the published declarations no longer import a driver the caller did not install.
