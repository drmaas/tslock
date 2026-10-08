---
'@tslock/neo4j': patch
'@tslock/couchbase': patch
'@tslock/s3': patch
'@tslock/gcs': patch
---

Ignore unlock when another instance owns the lock, so a stale holder cannot release it. On S3, the lock record is also written as the object body so the ETag changes when `lockedBy` or `lockUntil` changes and a stale unlock cannot overwrite a newer owner.
