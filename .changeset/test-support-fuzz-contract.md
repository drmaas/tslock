---
"@tslock/test-support": patch
---

Make the fuzz contract account for the logical end of protected work before awaiting network unlock acknowledgements, avoiding false concurrency failures with pipelined clients.
