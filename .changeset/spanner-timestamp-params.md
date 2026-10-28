---
'@tslock/spanner': patch
---

Decode Spanner TIMESTAMP `lockUntil` values from `Date` and `PreciseDate` as well as ISO strings, and mark unlock and extend DML timestamp parameters as `timestamp`.
