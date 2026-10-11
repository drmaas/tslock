---
'@tslock/nats': patch
---

Stop NATS unlock from deleting or overwriting a newer holder's key. Unlock writes only when the stored deadline still equals this lock's `lockAtMostUntil`, and `kv.delete` is conditional on the revision from that read. A lost compare-and-set resolves without throwing.
