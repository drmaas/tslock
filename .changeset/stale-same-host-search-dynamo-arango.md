---
'@tslock/core': patch
'@tslock/search-core': patch
'@tslock/dynamodb': patch
'@tslock/arangodb': patch
---

Ignore a stale unlock or extend after another process on the same host reacquires the lock. Search (Elasticsearch and OpenSearch), DynamoDB, and ArangoDB now require the stored deadline to match this acquisition. Delegating locks pass the deadline from the acquisition being extended.
