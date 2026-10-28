import { ClockProvider, createLockConfig, LockException, lockAtMostUntil } from '@tslock/core';
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

  const defaultOpts = {
    label: 'ShedLock',
    nameCol: 'name',
    lockUntilCol: 'lockUntil',
    lockedAtCol: 'lockedAt',
    lockedByCol: 'lockedBy',
  };

  function probeRecord(expired: boolean) {
    return { get: (key: string) => (key === 'expired' ? expired : undefined) };
  }

  it('updateRecord throws LockException when probe finds no node', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, defaultOpts);
    const rejection = accessor.updateRecord(config());
    await expect(rejection).rejects.toBeInstanceOf(LockException);
    await expect(rejection).rejects.toThrow('Lock record not found: test');
    expect(txRun).toHaveBeenCalledOnce();
    expect(txRun.mock.calls[0]![0]).not.toContain('SET');
  });

  it('updateRecord returns false when probe reports lock still held', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [probeRecord(false)] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, defaultOpts);
    const lock = config();
    const result = await accessor.updateRecord(lock);
    expect(result).toBe(false);
    expect(txRun).toHaveBeenCalledOnce();
    expect(txRun.mock.calls[0]![0]).not.toContain('SET');
    expect(txRun).toHaveBeenCalledWith(expect.stringContaining('AS expired'), {
      name: 'test',
      now: 1_000_000,
    });
  });

  it('updateRecord returns true when probe reports expired and update matches', async () => {
    const txRun = vi
      .fn()
      .mockResolvedValueOnce({ records: [probeRecord(true)] })
      .mockResolvedValueOnce({ records: [{}] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, defaultOpts, 'my-host');
    const lock = config('my-task', 10_000);
    const result = await accessor.updateRecord(lock);
    expect(result).toBe(true);
    expect(txRun).toHaveBeenCalledTimes(2);
    expect(txRun.mock.calls[1]![1]).toEqual({
      name: 'my-task',
      now: 1_000_000,
      lockUntil: 1_010_000,
      lockedAt: 1_000_000,
      lockedBy: 'my-host',
    });
  });

  it('updateRecord throws LockException when probe reports expired but update matches nothing', async () => {
    const txRun = vi
      .fn()
      .mockResolvedValueOnce({ records: [probeRecord(true)] })
      .mockResolvedValueOnce({ records: [] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, defaultOpts);
    const rejection = accessor.updateRecord(config());
    await expect(rejection).rejects.toBeInstanceOf(LockException);
    await expect(rejection).rejects.toThrow('Lock record not found: test');
    expect(txRun).toHaveBeenCalledTimes(2);
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

  it('unlock passes lockedBy for this instance', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [] });
    const driver = makeDriver(txRun);
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
    const lock = config('test');
    await accessor.unlock(lock);
    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining('WHERE lock.`lockedBy` = $lockedBy AND lock.`lockUntil` = $expectedLockUntil'),
      expect.objectContaining({ name: 'test', lockedBy: 'my-host', expectedLockUntil: lockAtMostUntil(lock) }),
    );
  });

  it('does not unlock or extend a newer same-host lock', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [{}] });
    const driver = makeDriver(txRun);
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
    const lock = config('test');
    const acquired = lockAtMostUntil(lock);
    const newerDeadline = acquired + 60_000;

    await accessor.unlock(lock);
    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining('lock.`lockUntil` = $expectedLockUntil'),
      expect.objectContaining({ lockedBy: 'my-host', expectedLockUntil: acquired }),
    );
    expect(txRun.mock.calls[0]![1].expectedLockUntil).not.toBe(newerDeadline);

    expect(await accessor.extend(lock)).toBe(false);
    expect(txRun).toHaveBeenCalledOnce();

    await accessor.extend(lock, acquired);
    expect(txRun).toHaveBeenLastCalledWith(
      expect.stringContaining('lock.`lockUntil` = $expectedLockUntil AND lock.`lockUntil` > $now'),
      expect.objectContaining({ lockedBy: 'my-host', expectedLockUntil: acquired, now: 1_000_000 }),
    );
    expect(txRun.mock.calls[1]![1].expectedLockUntil).not.toBe(newerDeadline);
  });

  it('extend returns false and does not write when no previous deadline is given', async () => {
    const txRun = vi.fn().mockResolvedValue({ records: [{}] });
    const driver = makeDriver(txRun);
    const accessor = new Neo4jStorageAccessor(driver, {
      label: 'ShedLock',
      nameCol: 'name',
      lockUntilCol: 'lockUntil',
      lockedAtCol: 'lockedAt',
      lockedByCol: 'lockedBy',
    });
    expect(await accessor.extend(config())).toBe(false);
    expect(txRun).not.toHaveBeenCalled();
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
    const lock = config();
    const result = await accessor.extend(lock, lockAtMostUntil(lock));
    expect(result).toBe(true);
    expect(txRun).toHaveBeenCalledWith(
      expect.stringContaining('lock.`lockUntil` = $expectedLockUntil'),
      expect.objectContaining({ expectedLockUntil: lockAtMostUntil(lock), lockUntil: lockAtMostUntil(lock) }),
    );
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
    const lock = config();
    const result = await accessor.extend(lock, lockAtMostUntil(lock));
    expect(result).toBe(false);
    expect(txRun).toHaveBeenCalledOnce();
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
    const params = txRun.mock.calls[0]![1];
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
