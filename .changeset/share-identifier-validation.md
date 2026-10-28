---

'@tslock/core': minor
'@tslock/sql-support': patch
'@tslock/sql': patch
'@tslock/kysely': patch
'@tslock/drizzle': patch
'@tslock/cassandra': patch
'@tslock/neo4j': patch
'@tslock/spanner': patch
---

Add shared `validateIdentifier()` in core and use it for SQL table/column names plus Cassandra, Neo4j, and Spanner configuration so unsafe identifiers cannot be interpolated into generated SQL.
