---

'@tslock/cassandra': patch
'@tslock/neo4j': patch
'@tslock/firestore': patch
'@tslock/datastore': patch
'@tslock/spanner': patch
'@tslock/couchbase': patch
---

Ignore a stale unlock or extend after another process on the same host reacquires the lock. Unlock and extend now require the stored deadline to match this acquisition.
