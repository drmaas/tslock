# @tslock/test-support

> Shared integration test contracts for TSLock providers.

This package defines the canonical integration test suites that **every** TSLock provider must pass, plus fuzz tests and small helpers. It's consumed by each provider package's test suite and is a dev-only dependency — you don't ship it to production.

## Installation

```bash
pnpm add -D @tslock/test-support @tslock/core vitest
```

## Usage

Extend your provider's integration test with the shared contract:

```typescript
import { describe } from 'vitest';
import { lockProviderIntegrationTests } from '@tslock/test-support';
import { MyLockProvider } from '../src/index.js';

describe('MyLockProvider integration', () => {
  lockProviderIntegrationTests(async () => new MyLockProvider(/* …backend setup… */));
});
```

## Exports

| Export | Description |
|---|---|
| `lockProviderIntegrationTests` | The base contract: lock once, skip if held, unlock, `lockAtLeastFor`, no extend if non-extensible. |
| `extensibleLockProviderIntegrationTests` | Adds: extend a held lock, reject extend if expired. |
| `storageBasedLockProviderIntegrationTests` | Adds: create record, reject duplicate, update when expired. |
| `fuzzTests` | N concurrent `lock()` calls — exactly one acquires. |
| `config`, `uniqueLockName`, `sleep`, `cleanupLock` | Test helpers. |
| `IntegrationTestOptions`, `StorageBasedIntegrationTestOptions` | The option types. |

## Requirements

- Node.js >= 22
- Dev: `vitest`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
