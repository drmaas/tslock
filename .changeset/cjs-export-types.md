---
'@tslock/arangodb': patch
'@tslock/aws-lambda': patch
'@tslock/bree': patch
'@tslock/cassandra': patch
'@tslock/cloudflare-do': patch
'@tslock/cloudflare-kv': patch
'@tslock/cloudfront-kvs': patch
'@tslock/core': patch
'@tslock/couchbase': patch
'@tslock/datastore': patch
'@tslock/drizzle': patch
'@tslock/dynamodb': patch
'@tslock/elasticsearch': patch
'@tslock/etcd': patch
'@tslock/express': patch
'@tslock/fastify': patch
'@tslock/firestore': patch
'@tslock/gcs': patch
'@tslock/hazelcast': patch
'@tslock/hono': patch
'@tslock/in-memory': patch
'@tslock/koa': patch
'@tslock/kysely': patch
'@tslock/memcached': patch
'@tslock/middleware-core': patch
'@tslock/mongo': patch
'@tslock/nats': patch
'@tslock/neo4j': patch
'@tslock/nestjs': patch
'@tslock/node-cron': patch
'@tslock/opensearch': patch
'@tslock/otel': patch
'@tslock/redis': patch
'@tslock/redis-core': patch
'@tslock/redis-ioredis': patch
'@tslock/s3': patch
'@tslock/scheduler-core': patch
'@tslock/search-core': patch
'@tslock/spanner': patch
'@tslock/sql': patch
'@tslock/sql-support': patch
'@tslock/test-support': patch
'@tslock/zookeeper': patch
---

Expose CommonJS and ESM type declarations on separate `require` and `import` export conditions so `node16` CommonJS projects can import every package.
