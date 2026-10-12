import type { Client } from '@elastic/elasticsearch';
import { ClockProvider, createLockConfig } from '@tslock/core';
import { LOCK_SCRIPT } from '@tslock/search-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElasticsearchLockProvider } from '../src/elasticsearch-lock-provider.js';

function client(update: ReturnType<typeof vi.fn>): Client {
  return { update } as unknown as Client;
}

describe('ElasticsearchLockProvider', () => {
  afterEach(() => {
    ClockProvider.resetClock();
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
});
