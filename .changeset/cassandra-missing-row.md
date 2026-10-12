---
'@tslock/cassandra': patch
---

Throw when a Cassandra conditional update finds no lock row, so the in-memory row cache clears and the next `lock()` can insert again. An update that is not applied still returns false when the lock-until column is set.
