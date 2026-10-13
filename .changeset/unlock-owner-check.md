---
'@tslock/mongo': patch
'@tslock/dynamodb': patch
'@tslock/arangodb': patch
'@tslock/search-core': patch
'@tslock/elasticsearch': patch
'@tslock/opensearch': patch
---

Unlock updates `lockUntil` only when the stored owner is this caller. Mongo filters the update by `lockedBy`. DynamoDB conditions the update on `lockedBy`. ArangoDB skips a different owner and updates with the document revision. Elasticsearch and OpenSearch unlock scripts set `lockUntil` only when `lockedBy` matches.
