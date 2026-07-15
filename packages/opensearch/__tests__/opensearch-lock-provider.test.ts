import type { Client } from '@opensearch-project/opensearch';
import { ClockProvider, createLockConfig } from '@tslock/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldNames } from '../src/field-names.js';
import { OpenSearchLockProvider } from '../src/opensearch-lock-provider.js';

function client(overrides: Record<string, unknown> = {}) {
  return { update: vi.fn().mockResolvedValue({ body: { result: 'updated' } }), ...overrides } as unknown as Client;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('OpenSearchLockProvider', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('lock() returns lock when update returns updated', async () => {
    const c = client();
    const provider = new OpenSearchLockProvider(c, { index: 'shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
  });

  it('lock() returns lock when update returns created (upsert)', async () => {
    const c = client({ update: vi.fn().mockResolvedValue({ body: { result: 'created' } }) });
    const provider = new OpenSearchLockProvider(c);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
  });

  it('lock() returns undefined when update returns noop', async () => {
    const c = client({ update: vi.fn().mockResolvedValue({ body: { result: 'noop' } }) });
    const provider = new OpenSearchLockProvider(c);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() returns undefined on 409 conflict', async () => {
    const c = client({ update: vi.fn().mockRejectedValue({ meta: { statusCode: 409 } }) });
    const provider = new OpenSearchLockProvider(c);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() propagates non-409 errors', async () => {
    const c = client({ update: vi.fn().mockRejectedValue(new Error('network')) });
    const provider = new OpenSearchLockProvider(c);
    await expect(provider.lock(config())).rejects.toThrow('network');
  });

  it('lock() passes refresh: wait_for', async () => {
    const fn = vi.fn().mockResolvedValue({ body: { result: 'updated' } });
    const c = client({ update: fn });
    const provider = new OpenSearchLockProvider(c);
    await provider.lock(config());
    expect(fn.mock.calls[0][0].refresh).toBe('wait_for');
  });

  it('lock() passes field names as script params with DEFAULT', async () => {
    const fn = vi.fn().mockResolvedValue({ body: { result: 'updated' } });
    const c = client({ update: fn });
    const provider = new OpenSearchLockProvider(c);
    await provider.lock(config());
    const params = fn.mock.calls[0][0].body.script.params;
    expect(params.lockUntilField).toBe('lockUntil');
    expect(params.lockedAtField).toBe('lockedAt');
    expect(params.lockedByField).toBe('lockedBy');
  });

  it('lock() passes snake_case field names with SNAKE_CASE', async () => {
    const fn = vi.fn().mockResolvedValue({ body: { result: 'updated' } });
    const c = client({ update: fn });
    const provider = new OpenSearchLockProvider(c, { fieldNames: FieldNames.SNAKE_CASE });
    await provider.lock(config());
    const params = fn.mock.calls[0][0].body.script.params;
    expect(params.lockUntilField).toBe('lock_until');
    expect(params.lockedAtField).toBe('locked_at');
    expect(params.lockedByField).toBe('locked_by');
  });

  it('lock() uses upsert keys with snake_case when configured', async () => {
    const fn = vi.fn().mockResolvedValue({ body: { result: 'updated' } });
    const c = client({ update: fn });
    const provider = new OpenSearchLockProvider(c, { fieldNames: FieldNames.SNAKE_CASE });
    await provider.lock(config());
    const upsert = fn.mock.calls[0][0].body.upsert;
    expect(upsert.lock_until).toBeDefined();
    expect(upsert.locked_at).toBeDefined();
    expect(upsert.locked_by).toBeDefined();
  });

  it('lock() passes ISO strings in script params', async () => {
    const fn = vi.fn().mockResolvedValue({ body: { result: 'updated' } });
    const c = client({ update: fn });
    ClockProvider.setClock(() => 1_000_000);
    const provider = new OpenSearchLockProvider(c);
    await provider.lock(createLockConfig('t', 30_000));
    const params = fn.mock.calls[0][0].body.script.params;
    expect(params.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.lockUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(params.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('extend() returns lock when update returns updated', async () => {
    const c = client();
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
  });

  it('extend() returns undefined when update returns noop', async () => {
    const c = client({
      update: vi
        .fn()
        .mockResolvedValueOnce({ body: { result: 'updated' } })
        .mockResolvedValue({ body: { result: 'noop' } }),
    });
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() returns undefined on 404 / not_found', async () => {
    const c = client({
      update: vi
        .fn()
        .mockResolvedValueOnce({ body: { result: 'updated' } })
        .mockRejectedValue({ meta: { statusCode: 404 } }),
    });
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() propagates non-404/409 errors', async () => {
    const c = client({
      update: vi
        .fn()
        .mockResolvedValueOnce({ body: { result: 'updated' } })
        .mockRejectedValue(new Error('network')),
    });
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    await expect(lock.extend(120_000, 0)).rejects.toThrow('network');
  });

  it('unlock() works', async () => {
    const c = client();
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    await lock.unlock();
  });

  it('unlock() swallows 404 errors', async () => {
    const c = client({
      update: vi
        .fn()
        .mockResolvedValueOnce({ body: { result: 'updated' } })
        .mockRejectedValue({ meta: { statusCode: 404 } }),
    });
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
  });

  it('unlock() propagates non-404 errors', async () => {
    const c = client({
      update: vi
        .fn()
        .mockResolvedValueOnce({ body: { result: 'updated' } })
        .mockRejectedValue(new Error('network')),
    });
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('network');
  });

  it('unlock after extend throws on original lock', async () => {
    const c = client();
    const provider = new OpenSearchLockProvider(c);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    await expect(lock.unlock()).rejects.toThrow('Lock has already been released or extended');
  });
});
