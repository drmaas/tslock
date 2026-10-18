import { describe, expect, it } from 'vitest';
import { createMemoryDoLockStorage, storageKeyForLock } from '../src/do-lock-storage.js';
import { applyLockOp, handleTslockLockRequest } from '../src/handle-lock-request.js';
import type { DoLockRecord, LockOp } from '../src/protocol.js';

function op(partial: {
  op: LockOp['op'];
  token: string;
  lockedBy?: string;
  createdAt?: number;
  lockAtMostFor?: number;
  lockAtLeastFor?: number;
  name?: string;
}): LockOp {
  return {
    name: 'job',
    lockAtMostFor: 60_000,
    lockAtLeastFor: 0,
    createdAt: 1_000_000,
    lockedBy: 'localhost',
    ...partial,
  } as LockOp;
}

function countPuts(storage: ReturnType<typeof createMemoryDoLockStorage>): {
  storage: ReturnType<typeof createMemoryDoLockStorage>;
  puts: () => number;
} {
  let writes = 0;
  return {
    storage: {
      async get(key) {
        return storage.get(key);
      },
      async put(key, value) {
        writes += 1;
        await storage.put(key, value);
      },
    },
    puts: () => writes,
  };
}

describe('applyLockOp', () => {
  it('acquires, skips while held, then allows after expiry', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    const acquired = await applyLockOp(storage, op({ op: 'lock', token: 'a', createdAt: now }), now);
    expect(acquired).toEqual({ ok: true, acquired: true, token: 'a' });

    const held = await applyLockOp(storage, op({ op: 'lock', token: 'b', lockedBy: 'b', createdAt: now + 1 }), now + 1);
    expect(held).toEqual({ ok: false, reason: 'held' });

    const afterExpiry = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'b', lockedBy: 'b', createdAt: now + 70_000 }),
      now + 70_000,
    );
    expect(afterExpiry).toEqual({ ok: true, acquired: true, token: 'b' });
  });

  it('extend requires the acquire token and an active lock', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    await applyLockOp(storage, op({ op: 'lock', token: 'a', createdAt: now }), now);

    const denied = await applyLockOp(
      storage,
      op({ op: 'extend', token: 'b', createdAt: now + 1_000, lockAtMostFor: 120_000 }),
      now + 1_000,
    );
    expect(denied).toEqual({ ok: false, reason: 'not_owner' });

    const extended = await applyLockOp(
      storage,
      op({
        op: 'extend',
        token: 'a',
        lockedBy: 'other-host',
        createdAt: now + 1_000,
        lockAtMostFor: 120_000,
      }),
      now + 1_000,
    );
    expect(extended).toEqual({ ok: true, extended: true });
    expect(await storage.get(storageKeyForLock('job'))).toMatchObject({
      lockUntil: now + 1_000 + 120_000,
      lockedBy: 'localhost',
      token: 'a',
    });

    const expired = await applyLockOp(
      storage,
      op({ op: 'extend', token: 'a', createdAt: now + 200_000, lockAtMostFor: 120_000 }),
      now + 200_000,
    );
    expect(expired).toEqual({ ok: false, reason: 'expired' });
  });

  it('matching-token unlock honors lockAtLeastFor', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    await applyLockOp(
      storage,
      op({ op: 'lock', token: 'a', createdAt: now, lockAtMostFor: 60_000, lockAtLeastFor: 5_000 }),
      now,
    );
    await applyLockOp(
      storage,
      op({ op: 'unlock', token: 'a', createdAt: now, lockAtMostFor: 60_000, lockAtLeastFor: 5_000 }),
      now + 1_000,
    );
    const record = await storage.get(storageKeyForLock('job'));
    expect(record).toMatchObject({ lockUntil: now + 5_000, lockedBy: 'localhost', token: 'a' });
    const again = await applyLockOp(storage, op({ op: 'lock', token: 'b', createdAt: now + 2_000 }), now + 2_000);
    expect(again).toEqual({ ok: false, reason: 'held' });
  });

  it('first token unlock after expiry leaves the second localhost hold unchanged', async () => {
    const storage = createMemoryDoLockStorage();
    const t0 = 1_000_000;
    const first = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'first', createdAt: t0, lockAtMostFor: 1_000 }),
      t0,
    );
    expect(first).toEqual({ ok: true, acquired: true, token: 'first' });

    const secondCreatedAt = t0 + 2_000;
    const second = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'second', createdAt: secondCreatedAt, lockAtMostFor: 60_000 }),
      secondCreatedAt,
    );
    expect(second).toEqual({ ok: true, acquired: true, token: 'second' });

    await applyLockOp(storage, op({ op: 'unlock', token: 'first', createdAt: t0, lockAtMostFor: 1_000 }), t0 + 3_000);

    const record = await storage.get(storageKeyForLock('job'));
    expect(record?.lockUntil).toBe(secondCreatedAt + 60_000);
    expect(record?.token).toBe('second');

    const third = await applyLockOp(storage, op({ op: 'lock', token: 'third', createdAt: t0 + 4_000 }), t0 + 4_000);
    expect(third).toEqual({ ok: false, reason: 'held' });
  });

  it('does not write unlock or extend when the token is wrong, even if lockedBy matches', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    await applyLockOp(storage, op({ op: 'lock', token: 'holder', createdAt: now }), now);
    const before = await storage.get(storageKeyForLock('job'));
    const watched = countPuts(storage);

    const unlock = await applyLockOp(watched.storage, op({ op: 'unlock', token: 'other', createdAt: now }), now + 1);
    const extend = await applyLockOp(
      watched.storage,
      op({ op: 'extend', token: 'other', createdAt: now + 1, lockAtMostFor: 120_000 }),
      now + 1,
    );
    const emptyUnlock = await applyLockOp(watched.storage, op({ op: 'unlock', token: '', createdAt: now }), now + 1);
    const emptyExtend = await applyLockOp(
      watched.storage,
      op({ op: 'extend', token: '', createdAt: now + 1, lockAtMostFor: 120_000 }),
      now + 1,
    );

    expect(unlock).toEqual({ ok: true });
    expect(extend).toEqual({ ok: false, reason: 'not_owner' });
    expect(emptyUnlock).toEqual({ ok: true });
    expect(emptyExtend).toEqual({ ok: false, reason: 'not_owner' });
    expect(watched.puts()).toBe(0);
    expect(await storage.get(storageKeyForLock('job'))).toEqual(before);
  });

  it('does not write an empty token and leaves a record without a token until it expires', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_000_000;
    const emptyLock = await applyLockOp(storage, op({ op: 'lock', token: '', createdAt: now }), now);
    expect(emptyLock).toEqual({ ok: false, reason: 'not_owner' });
    expect(await storage.get(storageKeyForLock('job'))).toBeUndefined();

    const legacy: DoLockRecord = { lockUntil: now + 5_000, lockedAt: now, lockedBy: 'localhost' };
    await storage.put(storageKeyForLock('job'), legacy);
    const watched = countPuts(storage);
    const unlock = await applyLockOp(watched.storage, op({ op: 'unlock', token: 'late', createdAt: now }), now + 1);
    const extend = await applyLockOp(watched.storage, op({ op: 'extend', token: 'late', createdAt: now + 1 }), now + 1);
    expect(unlock).toEqual({ ok: true });
    expect(extend).toEqual({ ok: false, reason: 'not_owner' });
    expect(watched.puts()).toBe(0);
    expect(await storage.get(storageKeyForLock('job'))).toEqual(legacy);

    const stillHeld = await applyLockOp(storage, op({ op: 'lock', token: 'next', createdAt: now + 1 }), now + 1);
    expect(stillHeld).toEqual({ ok: false, reason: 'held' });
    const afterExpiry = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'next', createdAt: now + 5_000 }),
      now + 5_000,
    );
    expect(afterExpiry).toEqual({ ok: true, acquired: true, token: 'next' });
  });

  it('stores lockUntil from the object clock when createdAt is far ahead', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_700_000_000_000;
    const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;
    const acquired = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'a', createdAt: now + tenYears, lockAtMostFor: 1_000 }),
      now,
    );
    expect(acquired).toEqual({ ok: true, acquired: true, token: 'a' });
    expect(await storage.get(storageKeyForLock('job'))).toMatchObject({
      lockedAt: now,
      lockUntil: now + 1_000,
      lockAtLeastUntil: now,
    });

    const held = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'b', createdAt: now + 500, lockAtMostFor: 1_000 }),
      now + 500,
    );
    expect(held).toEqual({ ok: false, reason: 'held' });

    const after = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'b', createdAt: now + 1_001, lockAtMostFor: 1_000 }),
      now + 1_001,
    );
    expect(after).toEqual({ ok: true, acquired: true, token: 'b' });
    expect((await storage.get(storageKeyForLock('job')))?.lockUntil).toBe(now + 1_001 + 1_000);
  });

  it('does not acquire an already-expired record when createdAt is 0', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_700_000_000_000;
    const acquired = await applyLockOp(
      storage,
      op({ op: 'lock', token: 'a', createdAt: 0, lockAtMostFor: 1_000, lockAtLeastFor: 200 }),
      now,
    );
    expect(acquired).toEqual({ ok: true, acquired: true, token: 'a' });
    const record = await storage.get(storageKeyForLock('job'));
    expect(record?.lockedAt).toBe(now);
    expect(record?.lockUntil).toBe(now + 1_000);
    expect(record?.lockAtLeastUntil).toBe(now + 200);
    expect(record!.lockUntil).toBeGreaterThan(now);

    const held = await applyLockOp(storage, op({ op: 'lock', token: 'b', createdAt: 0 }), now);
    expect(held).toEqual({ ok: false, reason: 'held' });
  });

  it('unlock keeps the stored minimum hold when the request clock is skewed', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_700_000_000_000;
    const years = 10 * 365 * 24 * 60 * 60 * 1000;
    await applyLockOp(
      storage,
      op({ op: 'lock', token: 'a', createdAt: now, lockAtMostFor: 60_000, lockAtLeastFor: 5_000 }),
      now,
    );
    await applyLockOp(
      storage,
      op({
        op: 'unlock',
        token: 'a',
        createdAt: now + years,
        lockAtMostFor: 60_000,
        lockAtLeastFor: 1e12,
      }),
      now + 1_000,
    );
    const record = await storage.get(storageKeyForLock('job'));
    expect(record?.lockUntil).toBe(now + 5_000);
    expect(record?.token).toBe('a');
  });

  it('unlock of a record without lockAtLeastUntil releases at the object clock', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_700_000_000_000;
    const legacy: DoLockRecord = {
      lockUntil: now + 60_000,
      lockedAt: now - 1_000,
      lockedBy: 'localhost',
      token: 'a',
    };
    await storage.put(storageKeyForLock('job'), legacy);
    await applyLockOp(
      storage,
      op({ op: 'unlock', token: 'a', createdAt: now + 9_999_999, lockAtLeastFor: 50_000, lockAtMostFor: 60_000 }),
      now + 2_000,
    );
    const record = await storage.get(storageKeyForLock('job'));
    expect(record?.lockUntil).toBe(now + 2_000);
    expect(record?.lockAtLeastUntil).toBeUndefined();
    expect(record?.token).toBe('a');
  });

  it('extend sets lockUntil from the object clock and only moves lockAtLeastUntil forward', async () => {
    const storage = createMemoryDoLockStorage();
    const now = 1_700_000_000_000;
    const years = 10 * 365 * 24 * 60 * 60 * 1000;
    await applyLockOp(
      storage,
      op({ op: 'lock', token: 'a', createdAt: now - years, lockAtMostFor: 60_000, lockAtLeastFor: 5_000 }),
      now,
    );

    const extended = await applyLockOp(
      storage,
      op({
        op: 'extend',
        token: 'a',
        createdAt: now + years,
        lockAtMostFor: 10_000,
        lockAtLeastFor: 1_000,
      }),
      now + 500,
    );
    expect(extended).toEqual({ ok: true, extended: true });
    expect(await storage.get(storageKeyForLock('job'))).toMatchObject({
      lockUntil: now + 500 + 10_000,
      lockAtLeastUntil: now + 5_000,
      lockedAt: now,
      token: 'a',
    });

    await applyLockOp(
      storage,
      op({
        op: 'extend',
        token: 'a',
        createdAt: now,
        lockAtMostFor: 30_000,
        lockAtLeastFor: 8_000,
      }),
      now + 1_000,
    );
    expect(await storage.get(storageKeyForLock('job'))).toMatchObject({
      lockUntil: now + 1_000 + 30_000,
      lockAtLeastUntil: now + 1_000 + 8_000,
    });
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

  it('returns 400 for an empty token', async () => {
    const storage = createMemoryDoLockStorage();
    const res = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op({ op: 'lock', token: '' })),
      }),
    );
    expect(res.status).toBe(400);
    expect(await storage.get(storageKeyForLock('job'))).toBeUndefined();
  });

  it('returns 400 for a negative duration', async () => {
    const storage = createMemoryDoLockStorage();
    const most = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op({ op: 'lock', token: 'a', lockAtMostFor: -1 })),
      }),
    );
    const least = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op({ op: 'lock', token: 'a', lockAtMostFor: 1_000, lockAtLeastFor: -1 })),
      }),
    );
    expect(most.status).toBe(400);
    expect(least.status).toBe(400);
    expect(await storage.get(storageKeyForLock('job'))).toBeUndefined();
  });

  it('returns 400 for a non-finite duration', async () => {
    const storage = createMemoryDoLockStorage();
    const body = JSON.stringify(op({ op: 'lock', token: 'a', lockAtMostFor: 1_000 })).replace(
      '"lockAtMostFor":1000',
      '"lockAtMostFor":1e309',
    );
    const res = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(res.status).toBe(400);
    expect(await storage.get(storageKeyForLock('job'))).toBeUndefined();
  });

  it('returns 400 when lockAtLeastFor is greater than lockAtMostFor', async () => {
    const storage = createMemoryDoLockStorage();
    const res = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op({ op: 'lock', token: 'a', lockAtMostFor: 1_000, lockAtLeastFor: 1_001 })),
      }),
    );
    expect(res.status).toBe(400);
    expect(await storage.get(storageKeyForLock('job'))).toBeUndefined();
  });

  it('handles a valid lock POST', async () => {
    const storage = createMemoryDoLockStorage();
    const res = await handleTslockLockRequest(
      storage,
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op({ op: 'lock', token: 'a', createdAt: 1_700_000_000_000 })),
      }),
      1_700_000_000_000,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, acquired: true, token: 'a' });
  });
});
