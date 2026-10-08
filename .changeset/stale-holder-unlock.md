---
'@tslock/neo4j': patch
'@tslock/couchbase': patch
'@tslock/s3': patch
'@tslock/gcs': patch
---

Ignore unlock when another instance owns the lock, so a stale holder cannot release it.
