---
"@tslock/core": patch
"@tslock/test-support": patch
---

Make the workspace install deterministic by explicitly denying optional native install scripts pulled in by testcontainers (`cpu-features` and `ssh2`). Standard local Docker-socket integration tests do not require these builds.
