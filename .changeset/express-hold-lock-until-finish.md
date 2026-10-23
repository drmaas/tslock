---
'@tslock/express': patch
---

Keep an Express route lock until the response finishes or `lockAtMostFor` elapses. A client disconnect no longer releases the lock while the route handler is still running, and unlock still runs once.
