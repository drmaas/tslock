import type { Client } from '@elastic/elasticsearch';
import { ClockProvider, createLockConfig, Utils } from '@tslock/core';
import { LOCK_SCRIPT, UNLOCK_SCRIPT } from '@tslock/search-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElasticsearchLockProvider } from '../src/elasticsearch-lock-provider.js';

function client(update: ReturnType<typeof vi.fn>): Client {
  return { update } as unknown as Client;
}

describe('ElasticsearchLockProvider', () => {
  afterEach(() => {
    ClockProvider.resetClock();
    vi.restoreAllMocks();
  });

  it('sends script and upsert at the top level and treats noop as not acquired', async () => {
    ClockProvider.setClock(() => 1_000_000);
    const update = vi.fn().mockResolvedValue({ result: 'noop' });
    const provider = new ElasticsearchLockProvider(client(update));
    const lock = await provider.lock(createLockConfig('test', 60_000));
    expect(lock).toBeUndefined();

    const request = update.mock.calls[0]![0];
    expect(request.id).toBe('test');
    expect(request.index).toBe('shedlock');
    expect(request.refresh).toBe('wait_for');
    expect(request.script.source).toBe(LOCK_SCRIPT);
    expect(request.script.params.lockUntilField).toBe('lockUntil');
    expect(request.upsert.lockUntil).toEqual(expect.any(String));
    expect(request.upsert.lockedAt).toEqual(expect.any(String));
    expect(request.upsert.lockedBy).toEqual(expect.any(String));
    expect(request.body).toBeUndefined();
  });

  it('unlock() sends this host so a different owner is left unchanged', async () => {
    ClockProvider.setClock(() => 1_000_000);
    vi.spyOn(Utils, 'getHostname').mockReturnValue('this-host');
    const update = vi.fn().mockResolvedValueOnce({ result: 'updated' }).mockResolvedValueOnce({ result: 'noop' });
    const provider = new ElasticsearchLockProvider(client(update));
    const lock = (await provider.lock(createLockConfig('report-job', 60_000, 5_000)))!;
    await expect(lock.unlock()).resolves.toBeUndefined();

    const request = update.mock.calls[1]![0];
    expect(request.script.source).toBe(UNLOCK_SCRIPT);
    expect(request.script.source).toContain('ctx._source[params.lockedByField] == params.lockedBy');
    expect(request.script.source).toContain("ctx.op = 'none'");
    expect(request.script.params.lockedBy).toBe('this-host');
    expect(request.script.params.lockedByField).toBe('lockedBy');
    expect(request.script.params.unlockTime).toBe('1970-01-01T00:16:45.000Z');
    expect(request.upsert).toBeUndefined();
  });
});
