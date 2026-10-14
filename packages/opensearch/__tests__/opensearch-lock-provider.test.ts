import type { Client } from '@opensearch-project/opensearch';
import { ClockProvider, createLockConfig, Utils } from '@tslock/core';
import { LOCK_SCRIPT, UNLOCK_SCRIPT } from '@tslock/search-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSearchLockProvider } from '../src/opensearch-lock-provider.js';

function client(update: ReturnType<typeof vi.fn>): Client {
  return { update } as unknown as Client;
}

describe('OpenSearchLockProvider', () => {
  afterEach(() => {
    ClockProvider.resetClock();
    vi.restoreAllMocks();
  });

  it('sends script and upsert under body and treats body.result noop as not acquired', async () => {
    ClockProvider.setClock(() => 1_000_000);
    const update = vi.fn().mockResolvedValue({ body: { result: 'noop' } });
    const provider = new OpenSearchLockProvider(client(update));
    const lock = await provider.lock(createLockConfig('test', 60_000));
    expect(lock).toBeUndefined();

    const request = update.mock.calls[0]![0];
    expect(request.id).toBe('test');
    expect(request.index).toBe('shedlock');
    expect(request.refresh).toBe('wait_for');
    expect(request.script).toBeUndefined();
    expect(request.body.script.source).toBe(LOCK_SCRIPT);
    expect(request.body.script.params.lockUntilField).toBe('lockUntil');
    expect(request.body.upsert.lockUntil).toEqual(expect.any(String));
    expect(request.body.upsert.lockedAt).toEqual(expect.any(String));
    expect(request.body.upsert.lockedBy).toEqual(expect.any(String));
  });

  it('unlock() sends this host so a different owner is left unchanged', async () => {
    ClockProvider.setClock(() => 1_000_000);
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const update = vi
      .fn()
      .mockResolvedValueOnce({ body: { result: 'updated' } })
      .mockResolvedValueOnce({ body: { result: 'noop' } });
    const provider = new OpenSearchLockProvider(client(update));
    const lock = (await provider.lock(createLockConfig('report-job', 60_000, 5_000)))!;
    await expect(lock.unlock()).resolves.toBeUndefined();

    const request = update.mock.calls[1]![0];
    expect(request.script).toBeUndefined();
    expect(request.body.script.source).toBe(UNLOCK_SCRIPT);
    expect(request.body.script.source).toContain('ctx._source[params.lockedByField] == params.lockedBy');
    expect(request.body.script.source).toContain("ctx.op = 'none'");
    expect(request.body.script.params.lockedBy).toBe('this-host');
    expect(request.body.script.params.lockedByField).toBe('lockedBy');
    expect(request.body.script.params.unlockTime).toBe('1970-01-01T00:16:45.000Z');
  });
});
