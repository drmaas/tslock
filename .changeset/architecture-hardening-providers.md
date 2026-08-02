---
'@tslock/core': patch
'@tslock/redis': patch
'@tslock/redis-ioredis': patch
'@tslock/firestore': patch
'@tslock/datastore': patch
'@tslock/spanner': patch
'@tslock/etcd': patch
'@tslock/memcached': patch
'@tslock/dynamodb': patch
'@tslock/neo4j': patch
---

Harden provider behavior: Redis integration contracts are available through opt-in Redis service tests, missing Firestore/Datastore/Spanner records now raise `LockException` during update, provider configuration errors use `LockException`, and Memcached/etcd TTLs use the shared no-early-expiry helper.
