# @tslock/search-core

> Shared Painless scripts, field names, and HTTP status helpers for the TSLock Elasticsearch and OpenSearch providers.

This package contains the dialect-agnostic lock knowledge shared by [`@tslock/elasticsearch`](../elasticsearch/README.md) and [`@tslock/opensearch`](../opensearch/README.md): the Painless `LOCK_SCRIPT` / `UNLOCK_SCRIPT` / `EXTEND_SCRIPT`, `SearchFieldNames` + `FieldNames` defaults, and `isConflictError` / `isNotFoundError`. It has **no Elasticsearch or OpenSearch client dependency**.

You normally don't depend on this directly. Use the provider packages instead. Reach for this package only if you're building a custom search-engine adapter that needs the same scripts and field conventions.

## Installation

```bash
pnpm add @tslock/search-core
```

## Exports

| Export | Description |
|---|---|
| `LOCK_SCRIPT`, `UNLOCK_SCRIPT`, `EXTEND_SCRIPT` | Shared Painless scripts. |
| `SearchFieldNames` (type) | `{ lockUntil, lockedAt, lockedBy }`. |
| `FieldNames` | `DEFAULT` and `SNAKE_CASE` presets. |
| `isConflictError`, `isNotFoundError` | HTTP 409 / 404 classifiers for client SDK errors. |

## Requirements

- Node.js >= 22

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
