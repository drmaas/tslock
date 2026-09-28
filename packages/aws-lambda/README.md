# @tslock/aws-lambda

> TSLock adapter for AWS Lambda and EventBridge Scheduler handlers.

Wraps a Lambda handler with `executeWithLock` so scheduled invocations skip when another instance (or overlapping invoke) holds the lock. No AWS SDK dependency — only `@tslock/core` and `@tslock/scheduler-core`.

## Installation

```bash
pnpm add @tslock/core @tslock/aws-lambda
```

## Usage

```typescript
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createAwsLambdaLock } from '@tslock/aws-lambda';

const lock = createAwsLambdaLock({
  lockProvider: new InMemoryLockProvider(),
  defaultLockAtMostFor: '5m',
});

export const handler = lock.wrapHandler(async (event) => {
  // one concurrent execution runs this body
  return { ok: true, event };
}, { name: 'eventbridge-job', lockAtMostFor: '5m' });
```

When the lock is held elsewhere, the wrapper skips the handler and resolves `undefined` (Lambda treats that as a successful empty response). Use a shared TSLock provider (Redis, DynamoDB, SQL, …) across instances.

## Requirements

- Node.js >= 22

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
