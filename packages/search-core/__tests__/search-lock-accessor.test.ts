import { ClockProvider, createLockConfig, Utils } from '@tslock/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTEND_SCRIPT,
  FieldNames,
  LOCK_SCRIPT,
  type SearchFieldNames,
  SearchLockAccessor,
  type SearchUpdateClient,
  type SearchUpdateRequest,
  UNLOCK_SCRIPT,
} from '../src/index.js';

function client(update: SearchUpdateClient['update']): SearchUpdateClient {
  return { update };
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

function accessor(update: SearchUpdateClient['update'], fieldNames: SearchFieldNames = FieldNames.DEFAULT) {
  return new SearchLockAccessor(client(update), 'shedlock-test', fieldNames);
}

function sent(update: ReturnType<typeof vi.fn>, call = 0): SearchUpdateRequest {
  return update.mock.calls[call]![0] as SearchUpdateRequest;
}

describe('SearchLockAccessor', () => {
  afterEach(() => {
    ClockProvider.resetClock();
    vi.restoreAllMocks();
  });

  it('lock() returns lock when update returns updated', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const lock = await accessor(update).lock(config());
    expect(lock).toBeDefined();
  });

  it('lock() returns lock when update returns created (upsert)', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'created' });
    const lock = await accessor(update).lock(config());
    expect(lock).toBeDefined();
  });

  it('lock() returns undefined when update returns noop', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'noop' });
    const lock = await accessor(update).lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() returns undefined on 409 conflict', async () => {
    const update = vi.fn().mockRejectedValue({ meta: { statusCode: 409 } });
    const lock = await accessor(update).lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() propagates non-409 errors', async () => {
    const update = vi.fn().mockRejectedValue(new Error('network'));
    await expect(accessor(update).lock(config())).rejects.toThrow('network');
  });

  it('lock() passes refresh: wait_for', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    await accessor(update).lock(config());
    expect(sent(update).refresh).toBe('wait_for');
    expect(sent(update).id).toBe('test');
    expect(sent(update).index).toBe('shedlock-test');
  });

  it('lock() passes field names as script params with DEFAULT', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    await accessor(update).lock(config());
    const params = sent(update).script.params;
    expect(sent(update).script.source).toBe(LOCK_SCRIPT);
    expect(params.lockUntilField).toBe('lockUntil');
    expect(params.lockedAtField).toBe('lockedAt');
    expect(params.lockedByField).toBe('lockedBy');
  });

  it('lock() passes snake_case field names with SNAKE_CASE', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    await accessor(update, FieldNames.SNAKE_CASE).lock(config());
    const params = sent(update).script.params;
    expect(params.lockUntilField).toBe('lock_until');
    expect(params.lockedAtField).toBe('locked_at');
    expect(params.lockedByField).toBe('locked_by');
  });

  it('lock() uses upsert keys with snake_case when configured', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    await accessor(update, FieldNames.SNAKE_CASE).lock(config());
    const upsert = sent(update).upsert;
    expect(upsert?.lock_until).toBeDefined();
    expect(upsert?.locked_at).toBeDefined();
    expect(upsert?.locked_by).toBeDefined();
  });

  it('lock() passes ISO strings in script params', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    ClockProvider.setClock(() => 1_000_000);
    await accessor(update).lock(createLockConfig('t', 30_000));
    const params = sent(update).script.params;
    expect(params.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.lockUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('extend() returns lock when update returns updated', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const lock = (await accessor(update).lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(sent(update, 1).script.source).toBe(EXTEND_SCRIPT);
    expect(sent(update, 1).script.params.expectedLockUntil).toBe('1970-01-01T00:17:40.000Z');
    expect(sent(update, 1).script.params.lockUntil).toBe('1970-01-01T00:18:40.000Z');
  });

  it('extend() does not write when the previous deadline is missing', async () => {
    const update = vi.fn();
    await expect(accessor(update).extend(config())).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('extend() returns undefined when update returns noop', async () => {
    const update = vi.fn().mockResolvedValueOnce({ result: 'updated' }).mockResolvedValue({ result: 'noop' });
    const lock = (await accessor(update).lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() returns undefined on 404 / not_found', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ result: 'updated' })
      .mockRejectedValue({ meta: { statusCode: 404 } });
    const lock = (await accessor(update).lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() returns undefined on 409 conflict', async () => {
    const update = vi.fn().mockResolvedValueOnce({ result: 'updated' }).mockRejectedValue({ statusCode: 409 });
    const lock = (await accessor(update).lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() propagates non-404/409 errors', async () => {
    const update = vi.fn().mockResolvedValueOnce({ result: 'updated' }).mockRejectedValue(new Error('network'));
    const lock = (await accessor(update).lock(config()))!;
    await expect(lock.extend(120_000, 0)).rejects.toThrow('network');
  });

  it('unlock() works', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const lock = (await accessor(update).lock(config('test', 60_000, 5_000)))!;
    await lock.unlock();
    const request = sent(update, 1);
    expect(request.script.source).toBe(UNLOCK_SCRIPT);
    expect(request.script.params.lockedBy).toBe('this-host');
    expect(request.script.params.lockedByField).toBe('lockedBy');
    expect(request.script.params.unlockTime).toBe('1970-01-01T00:16:45.000Z');
    expect(request.script.params.expectedLockUntil).toBe('1970-01-01T00:17:40.000Z');
    expect(request.upsert).toBeUndefined();
  });

  it('unlock() sends this host so a different stored owner is left unchanged', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const update = vi.fn().mockResolvedValueOnce({ result: 'updated' }).mockResolvedValueOnce({ result: 'noop' });
    const lock = (await accessor(update).lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    const request = sent(update, 1);
    expect(request.script.source).toContain('ctx._source[params.lockedByField] == params.lockedBy');
    expect(request.script.source).toContain("ctx.op = 'none'");
    expect(request.script.params.lockedBy).toBe('this-host');
    expect(request.script.params.lockedByField).toBe('lockedBy');
  });

  it('unlock() passes the configured lockedBy field name', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const lock = (await accessor(update, FieldNames.SNAKE_CASE).lock(config()))!;
    await lock.unlock();
    expect(sent(update, 1).script.params.lockedByField).toBe('locked_by');
    expect(sent(update, 1).script.params.lockedBy).toBe('this-host');
  });

  it('unlock() swallows 404 errors', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ result: 'updated' })
      .mockRejectedValue({ meta: { statusCode: 404 } });
    const lock = (await accessor(update).lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
  });

  it('unlock() propagates non-404 errors', async () => {
    const update = vi.fn().mockResolvedValueOnce({ result: 'updated' }).mockRejectedValue(new Error('network'));
    const lock = (await accessor(update).lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('network');
  });

  it('unlock after extend throws on original lock', async () => {
    const update = vi.fn().mockResolvedValue({ result: 'updated' });
    const lock = (await accessor(update).lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    await expect(lock.unlock()).rejects.toThrow('Lock has already been released or extended');
  });
});
