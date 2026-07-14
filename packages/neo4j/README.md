# @tslock/neo4j

> TSLock provider backed by [Neo4j](https://neo4j.com/).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern from [`@tslock/core`](../core/README.md) with a `StorageAccessor` that issues Cypher against a dedicated `:ShedLock` node label. A unique constraint on `name` guarantees at-most-one insert across concurrent instances; updates use `lockUntil <= now()` to acquire an expired lock.

## Installation

```bash
pnpm add @tslock/core @tslock/neo4j neo4j-driver
```

## Setup

Create a unique constraint once:

```cypher
CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS
FOR (n:ShedLock) REQUIRE n.name IS UNIQUE;
```

Or use the included helper:

```typescript
import { createUniqueConstraint } from '@tslock/neo4j';
await createUniqueConstraint(driver);
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { Neo4jLockProvider } from '@tslock/neo4j';
import neo4j from 'neo4j-driver';

const driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', 'password'));

const provider = new Neo4jLockProvider(driver);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new Neo4jLockProvider(driver, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `label` | `'ShedLock'` | The node label used to store lock records (must match your constraint). |
| `columnNames` | see below | Override any of `name`, `lockUntil`, `lockedAt`, `lockedBy`. |
| `lockedByValue` | `os.hostname()` | Identifier written to `lockedBy`. |
| `database` | default database | The Neo4j database to query. |

Default property names: `name`, `lockUntil`, `lockedAt`, `lockedBy`.

## Requirements

- Node.js >= 22
- Peer: `neo4j-driver`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
