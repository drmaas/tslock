---
'@tslock/search-core': patch
'@tslock/elasticsearch': patch
'@tslock/opensearch': patch
---

Extract shared Elasticsearch/OpenSearch Painless scripts, field-name presets, and HTTP status helpers into `@tslock/search-core`. Provider public exports stay compatible via type aliases.
