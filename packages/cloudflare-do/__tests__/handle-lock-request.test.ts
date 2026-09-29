import { describe, expect, it } from 'vitest';
import { createMemoryDoLockStorage } from '../src/do-lock-storage.js';
import { applyLockOp, handleTslockLockRequest } from '../src/handle-lock-request.js';

describe('applyLockOp', () => {
  it('acquires, skips while held, then allows after expiry', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    const acquired = await applyLockOp(
      storage,
      {
        op: 'lock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 0,
        createdAt: now,
        lockedBy: 'a',
      },
      now,
    );
    expect(acquired).toEqual({ ok: true, acquired: true });

    const held = await applyLockOp(
      storage,
      {
        op: 'lock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 0,
        createdAt: now + 1,
        lockedBy: 'b',
      },
      now + 1,
    );
    expect(held).toEqual({ ok: false, reason: 'held' });

    const afterExpiry = await applyLockOp(
      storage,
      {
        op: 'lock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 0,
        createdAt: now + 70_000,
        lockedBy: 'b',
      },
      now + 70_000,
    );
    expect(afterExpiry).toEqual({ ok: true, acquired: true });
  });

  it('extend requires owner and active lock', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    await applyLockOp(
      storage,
      {
        op: 'lock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 0,
        createdAt: now,
        lockedBy: 'a',
      },
      now,
    );

    const denied = await applyLockOp(
      storage,
      {
        op: 'extend',
        name: 'job',
        lockAtMostFor: 120_000,
        lockAtLeastFor: 0,
        createdAt: now + 1_000,
        lockedBy: 'b',
      },
      now + 1_000,
    );
    expect(denied).toEqual({ ok: false, reason: 'not_owner' });

    const extended = await applyLockOp(
      storage,
      {
        op: 'extend',
        name: 'job',
        lockAtMostFor: 120_000,
        lockAtLeastFor: 0,
        createdAt: now + 1_000,
        lockedBy: 'a',
      },
      now + 1_000,
    );
    expect(extended).toEqual({ ok: true, extended: true });
  });

  it('unlock respects lockAtLeastFor', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    await applyLockOp(
      storage,
      {
        op: 'lock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 5_000,
        createdAt: now,
        lockedBy: 'a',
      },
      now,
    );
    await applyLockOp(
      storage,
      {
        op: 'unlock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 5_000,
        createdAt: now,
        lockedBy: 'a',
      },
      now + 1_000,
    );
    const again = await applyLockOp(
      storage,
      {
        op: 'lock',
        name: 'job',
        lockAtMostFor: 60_000,
        lockAtLeastFor: 0,
        createdAt: now + 2_000,
        lockedBy: 'b',
      },
      now + 2_000,
    );
    expect(again).toEqual({ ok: false, reason: 'held' });
  });
});

describe('handleTslockLockRequest', () => {
  it('returns 400 for invalid bodies', async () => {
    const storage = createMemoryDoLockStorage();
    const res = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(400);
  });

  it('handles a valid lock POST', async () => {
    const storage = createMemoryDoLockStorage();
    const res = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'lock',
          name: 'job',
          lockAtMostFor: 60_000,
          lockAtLeastFor: 0,
          createdAt: Date.now(),
          lockedBy: 'a',
        }),
      }),
      Date.now(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, acquired: true });
  });
});
