---
'@tslock/express': patch
---

Derive Express default lock names from the matched route pattern (`baseUrl` + `route.path`), with case/trailing-slash normalization aligned to Express routing settings. Parameterized routes now share one lock name (e.g. `GET:/jobs/:id`); previous per-id lock records may be orphaned until they expire.
