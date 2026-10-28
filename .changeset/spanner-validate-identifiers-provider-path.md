---

## '@tslock/spanner': patch

Validate Spanner table and column identifiers in `SpannerStorageAccessor` so `createSpannerProvider` cannot pass unsafe names into generated DML.
