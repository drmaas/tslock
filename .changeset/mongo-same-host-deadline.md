---

## '@tslock/mongo': patch

Ignore a stale unlock or extend after another process on the same host reacquires a MongoDB lock. Unlock and extend now require the stored deadline to match this acquisition.
