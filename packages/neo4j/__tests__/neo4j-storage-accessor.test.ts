import { ClockProvider, createLockConfig } from '@tslock/core';
import type { Driver } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';
import { Neo4jStorageAccessor } from '../src/neo4j-storage-accessor.js';

function makeDriver(txRun: ReturnType<typeof vi.fn> = vi.fn()) {
  const session = {
    executeWrite: vi
      .fn()
      .mockImplementation(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => unknown) => fn({ run: txRun })),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('Neo4jStorageAccessor', () => {
  it('insertRecord returns true when no conflict', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    const result = await accessor.insertRecord(config());
    expect(result).toBe(true);
    expect(txRun).toHaveBeenCalledOnce();
  });

  it('insertRecord returns false on constraint violation', async () => {
    const err = new Error("already exists with label `ShedLock` and property `name` = 'test'");
    (err as unknown as { code: string }).code = 'Neo.ClientError.Schema.ConstraintValidationFailed';
    const txRun = vi.fn().mockRejectedValue(err);
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    const result = await accessor.insertRecord(config());
    expect(result).toBe(false);
  });

  it('insertRecord propagates non-constraint errors', async () => {
    const txRun = vi.fn().mockRejectedValue(new Error('connection refused'));
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    await expect(accessor.insertRecord(config())).rejects.toThrow('connection refused');
  });

  it('insertRecord propagates constraint error for a different lock name', async () => {
    const err = new Error("already exists with label `ShedLock` and property `name` = 'other-task'");
    (err as unknown as { code: string }).code = 'Neo.ClientError.Schema.ConstraintValidationFailed';
    const txRun = vi.fn().mockRejectedValue(err);
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    await expect(accessor.insertRecord(config('other-task'))).resolves.toBe(false);
  });

  it('updateRecord returns true when record matched', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [{}, {}] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    const result = await accessor.updateRecord(config());
    expect(result).toBe(true);
  });

  it('updateRecord returns false when no record matched', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    const result = await accessor.updateRecord(config());
    expect(result).toBe(false);
  });

  it('unlock resolves without inspecting result', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    await accessor.unlock(config());
    expect(txRun).toHaveBeenCalledOnce();
  });

  it('extend returns true when record matched', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [{}] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    const result = await accessor.extend(config());
    expect(result).toBe(true);
  });

  it('extend returns false when no record matched', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    const result = await accessor.extend(config());
    expect(result).toBe(false);
  });

  it('executesWrite passes parameters correctly', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const session = {
      executeWrite: vi
        .fn()
        .mockImplementation(async (fn: (tx: { run: ReturnType<typeof vi.fn> }) => unknown) => fn({ run: txRun })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const driver = { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
    const accessor = new Neo4jStorageAccessor(
      driver,
      {
        label: 'ShedLock',
        nameCol: 'name',
        lockUntilCol: 'lockUntil',
        lockedAtCol: 'lockedAt',
        lockedByCol: 'lockedBy',
      },
      'my-host',
    );
    const cfg = config('my-task', 10_000);
    await accessor.insertRecord(cfg);
    const params = txRun.mock.calls[0][1];
    expect(params.name).toBe('my-task');
    expect(params.lockUntil).toBe(1_010_000);
    expect(params.lockedBy).toBe('my-host');
  });

  it('closes session in finally', async () => {
    const session = {
      executeWrite: vi.fn().mockRejectedValue(new Error('fail')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const driver = { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    await expect(accessor.insertRecord(config())).rejects.toThrow('fail');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
