---

'@tslock/search-core': minor
'@tslock/elasticsearch': patch
'@tslock/opensearch': patch
---

Share one Elasticsearch and OpenSearch lock accessor. `SearchLockAccessor` in `@tslock/search-core` owns lock, extend, and unlock. Each provider keeps a thin client adapter for its update envelope.
