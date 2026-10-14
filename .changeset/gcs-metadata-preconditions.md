---
'@tslock/gcs': patch
---

Store GCS lock fields in object custom metadata. Uploads and metadata updates send `ifGenerationMatch`, and a later upload or metadata update also sends `ifMetagenerationMatch` so a metadata patch cannot be overwritten while the object generation stays the same.
