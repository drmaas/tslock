---
'@tslock/core': patch
---

Keep-alive renewals continue past the original `lockAtMostFor`. The interval stops only after the deadline from the latest successful extend has passed, and that stop reports `Keep-alive lock was lost`.
