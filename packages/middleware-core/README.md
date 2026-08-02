# @tslock/middleware-core

> Shared lifecycle and configuration infrastructure for TSLock framework integrations.

Framework adapters use this package to resolve route configuration, derive lock names, acquire locks around handlers, and build lock-failure responses.

## Failure response semantics

When a request cannot acquire its lock, the `lockUntil` metadata is an approximation: it is calculated as the current time plus the configured `lockAtMostFor`. The actual holder's expiry is not available when `lock()` returns `undefined.

## Handler lifetime semantics

Koa and Hono hold the lock while awaiting the handler. A handler that never resolves therefore holds the lock until the natural `lockAtMostFor` expiry. Express uses a `lockAtMostFor`-based timeout around the response lifecycle. Configure `lockAtMostFor` generously enough for the handler's expected duration.

## Requirements

- Node.js >= 22
- Peer: `@tslock/core`
