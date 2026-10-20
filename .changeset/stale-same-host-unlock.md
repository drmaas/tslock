---
'@tslock/core': patch
'@tslock/s3': patch
'@tslock/gcs': patch
'@tslock/cloudfront-kvs': patch
---

Ignore a stale unlock or extend after another process on the same host reacquires the lock. S3, GCS, and CloudFront KeyValueStore now require the stored deadline to match this acquisition. `StorageAccessor.extend` takes an optional previous deadline, and storage locks pass the deadline they acquired.
