---
'@tslock/gcs': patch
---

Store GCS lock fields in object custom metadata and send `ifGenerationMatch` on the query parameters that `@google-cloud/storage` forwards for uploads and metadata updates.
