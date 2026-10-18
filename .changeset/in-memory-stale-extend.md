---
'@tslock/in-memory': patch
---

`extend()` updates the in-memory deadline only while the map still stores this acquisition's deadline and that deadline is still in the future. After another caller reacquires the lock, a stale `extend()` returns `undefined` and leaves the new holder's deadline unchanged, including when `KeepAliveLockProvider` renews.
