---
'@tslock/hazelcast': patch
'@tslock/memcached': patch
'@tslock/etcd': patch
---

Unlock deletes or rewrites a lock only when this caller still owns it. Hazelcast compares `lockedBy`, `lockedAt`, and `lockUntil` with the record this acquisition wrote. Memcached compares the stored value before `delete` or `replace`. Etcd attaches a shortened lease only when the key is still on the original lease, and revokes that lease either way.
