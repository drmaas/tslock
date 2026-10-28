---

## '@tslock/zookeeper': patch

Treat promisified ZooKeeper `NodeExists` (`-110`) errors as lock not acquired during create, matching `NoNode` and `BadVersion` message-form handling.
