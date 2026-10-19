---
'@tslock/core': patch
---

`DefaultLockingTaskExecutor` unlocks the lock `LockExtender.extendActiveLock` installed, so a task that extends its lease does not hold it until the new deadline after `executeWithLock` returns. A failed `extend()` leaves the original handle valid so that unlock still runs. `unlock()` on the original handle still throws after a successful `extend()`.
