---
'@tslock/core': minor
'@tslock/otel': minor
---

Brand `ExtensibleLockProvider` so `KeepAliveLockProvider` only accepts providers that can extend a lock. `TrackingLockProviderWrapper` and OpenTelemetry `instrument` keep that brand only when the wrapped provider is extensible. Constructing keep-alive around a provider that omits the brand throws `LockException` instead of failing on the first renewal. Custom classes that implement `ExtensibleLockProvider` must set `readonly [extensibleLockProvider]: true`.
