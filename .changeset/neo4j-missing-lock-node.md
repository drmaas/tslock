---

## '@tslock/neo4j': patch

Throw when a Neo4j lock node is missing during `updateRecord`, so the in-memory lock registry clears and the next `lock()` can insert again. A still-held lock still returns false without writing.
