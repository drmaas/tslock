import type { Client } from '@opensearch-project/opensearch';
import { ClockProvider, createLockConfig } from '@tslock/core';
import { LOCK_SCRIPT } from '@tslock/search-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSearchLockProvider } from '../src/opensearch-lock-provider.js';

function client(update: ReturnType<typeof vi.fn>): Client {
  return { update } as unknown as Client;
}

describe('OpenSearchLockProvider', () => {
  afterEach(() => {
    ClockProvider.resetClock();
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
});
