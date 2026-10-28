---

## '@tslock/in-memory': patch

`unlock()` writes `lockAtLeastUntil` only while the map still stores this acquisition's `lockAtMostUntil`. After another caller reacquires the name with a different deadline, a stale `unlock()` leaves that deadline unchanged. An unlock that still matches the stored deadline applies `lockAtLeastFor`.
