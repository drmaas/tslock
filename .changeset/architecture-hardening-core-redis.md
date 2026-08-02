---
'@tslock/core': patch
'@tslock/redis-core': patch
'@tslock/test-support': patch
---

Harden core and Redis: memoize `Utils.getHostname()`, add `Utils.toTtlSeconds` and `Utils.validateLockName` (control chars + 1024-byte limit, enforced by `createLockConfig`), scan the full stack in `LockAssert.alreadyLockedBy`, clear the `StorageBasedLockProvider` registry on any `updateRecord` exception, relocate `LockAssert.TestHelper` to `@tslock/test-support`, retry keep-alive extensions once before deactivating with an `onKeepAliveFailure` hook, add the optional `onUnlockError` executor listener, use the real hostname + `crypto.randomUUID()` in Redis lock values, and honor `lockAtLeastFor` on Redis unlock via a new `KEEP_IF_EQUALS_SCRIPT`.
