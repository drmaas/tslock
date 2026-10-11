---
'@tslock/zookeeper': patch
---

Stop ZooKeeper unlock from overwriting a newer holder's znode. Unlock writes `unlockTime` only when the znode still contains this lock's `lockAtMostUntil`, using the version from that read. `NoNode` and `BadVersion` resolve without a write.
