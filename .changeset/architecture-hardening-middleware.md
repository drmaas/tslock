---
'@tslock/middleware-core': patch
'@tslock/express': patch
'@tslock/fastify': patch
'@tslock/koa': patch
'@tslock/hono': patch
---

Improve middleware hot-path performance and type safety: resolve global durations once, cache route resolutions by configuration identity, type resolved lock-failure bodies, remove redundant resolved lock-name state, and resolve Express handler timeouts during route registration.
