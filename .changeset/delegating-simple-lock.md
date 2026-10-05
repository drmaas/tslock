---
'@tslock/core': minor
'@tslock/mongo': patch
'@tslock/dynamodb': patch
'@tslock/elasticsearch': patch
'@tslock/opensearch': patch
'@tslock/arangodb': patch
'@tslock/hazelcast': patch
---

Replace six copy-pasted provider lock classes with core `DelegatingSimpleLock`.
