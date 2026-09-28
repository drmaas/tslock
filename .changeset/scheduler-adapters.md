---
'@tslock/scheduler-core': minor
'@tslock/node-cron': minor
'@tslock/bree': minor
'@tslock/aws-lambda': minor
---

Add thin scheduler adapters (`node-cron`, `bree`, AWS Lambda) backed by `@tslock/scheduler-core` so cron and scheduled handlers wrap with `executeWithLock` without putting a scheduler in core.
