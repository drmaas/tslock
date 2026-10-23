---
'@tslock/in-memory': patch
---

`unlock()` writes `lockAtLeastUntil` only while the map still stores this acquisition's `lockAtMostUntil`. After another caller reacquires the lock, a stale `unlock()` leaves the new holder's deadline unchanged. An unlock of the current acquisition still applies `lockAtLeastFor`.
