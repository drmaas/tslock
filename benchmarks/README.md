# TSLock benchmarks

This directory is intentionally outside the pnpm workspace. Benchmarks run against built package artifacts and are not part of the normal typecheck, test, or build aggregates.

## Run

```bash
pnpm bench
```

The command builds the workspace and measures:

- in-memory lock/unlock round trips;
- `DefaultLockingTaskExecutor.executeWithLock` overhead;
- middleware lifecycle per-request overhead.

Set `TSLOCK_BENCH_ITERATIONS` to change the number of measured operations:

```bash
TSLOCK_BENCH_ITERATIONS=50000 pnpm bench
```

Results depend on the machine and Node.js runtime. Record representative results in an issue or release note rather than treating them as a CI gate.

## AsyncLocalStorage decision

The benchmark is the measurement point for `AsyncLocalStorage` overhead. Merging the `LockAssert` and `LockExtender` stores remains deferred to v2 unless profiling demonstrates a material cost; this v1.x hardening pass preserves both public stores and their current semantics.
