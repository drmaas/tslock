import { ClockProvider, createLockConfig, lockAtMostUntil, Utils } from '@tslock/core';
import type { DocumentCollection, EdgeCollection } from 'arangojs/collections';
import type { Database } from 'arangojs/databases';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArangoDbAccessor } from '../src/arangodb-accessor.js';
import type { ArangoDbLockDocument } from '../src/arangodb-lock-document.js';
import { ArangoDbLockProvider } from '../src/arangodb-lock-provider.js';

type ArangoCollection<T extends Record<string, unknown>> = DocumentCollection<T> & EdgeCollection<T>;
type StoredLock = ArangoDbLockDocument & { _rev: string };

class MemoryCollection {
  readonly docs = new Map<string, StoredLock>();
  readonly updates: { key: string; patch: Partial<ArangoDbLockDocument>; ifMatch?: string }[] = [];
  private rev = 0;

  readonly document = async (key: string): Promise<StoredLock> => {
    const doc = this.docs.get(key);
    if (!doc) throw { errorNum: 1202, code: 1202 };
    return { ...doc };
  };

  readonly save = async (doc: ArangoDbLockDocument): Promise<{ _rev: string }> => {
    this.rev += 1;
    const stored = { ...doc, _rev: `rev-${this.rev}` };
    this.docs.set(doc._key, stored);
    return { _rev: stored._rev };
  };

  readonly update = async (
    key: string,
    patch: Partial<ArangoDbLockDocument>,
    options?: { ifMatch?: string },
  ): Promise<StoredLock> => {
    this.updates.push({ key, patch, ifMatch: options?.ifMatch });
    const existing = this.docs.get(key);
    if (!existing) throw { errorNum: 1202, code: 1202 };
    if (options?.ifMatch !== undefined && options.ifMatch !== existing._rev) throw { errorNum: 1200, code: 1200 };
    this.rev += 1;
    const next = { ...existing, ...patch, _rev: `rev-${this.rev}` };
    this.docs.set(key, next);
    return { ...next };
  };

  asCollection(): ArangoCollection<ArangoDbLockDocument> {
    return {
      name: 'shedLock',
      document: this.document,
      save: this.save,
      update: this.update,
    } as unknown as ArangoCollection<ArangoDbLockDocument>;
  }
}

function database(): Database {
  return {
    beginTransaction: vi.fn().mockImplementation(async () => ({
      step: (fn: () => unknown) => fn(),
      commit: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    })),
  } as unknown as Database;
}

describe('ArangoDB same-host ownership', () => {
  afterEach(() => {
    ClockProvider.resetClock();
    vi.restoreAllMocks();
  });

  it('does not unlock or extend a newer lock acquired by the same host', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const collection = new MemoryCollection();
    const provider = new ArangoDbLockProvider(collection.asCollection(), database());
    const unlockConfig = createLockConfig('unlock-job', 5_000);
    const unlockLock = await provider.lock(unlockConfig);
    expect(unlockLock).toBeDefined();
    now = 1_006_000;
    expect(await provider.lock(createLockConfig('unlock-job', 60_000))).toBeDefined();
    const unlockHeld = collection.docs.get('unlock-job')?.lockUntil;
    const updatesAfterReacquire = collection.updates.length;
    await unlockLock?.unlock();

    now = 1_000_000;
    const extendConfig = createLockConfig('extend-job', 5_000);
    const extendLock = await provider.lock(extendConfig);
    expect(extendLock).toBeDefined();
    now = 1_006_000;
    expect(await provider.lock(createLockConfig('extend-job', 60_000))).toBeDefined();
    const extendHeld = collection.docs.get('extend-job')?.lockUntil;
    const updatesBeforeExtend = collection.updates.length;
    expect(await extendLock?.extend(120_000, 0)).toBeUndefined();

    expect(collection.updates).toHaveLength(updatesBeforeExtend);
    expect(collection.updates).toHaveLength(updatesAfterReacquire + 1);
    expect(collection.docs.get('unlock-job')?.lockUntil).toBe(unlockHeld);
    expect(collection.docs.get('unlock-job')?.lockedBy).toBe('host-a');
    expect(collection.docs.get('extend-job')?.lockUntil).toBe(extendHeld);
    expect(collection.docs.get('extend-job')?.lockedBy).toBe('host-a');
    expect(unlockHeld).not.toBe(Utils.toIsoString(lockAtMostUntil(unlockConfig)));
    expect(extendHeld).not.toBe(Utils.toIsoString(lockAtMostUntil(extendConfig)));
  });

  it('unlocks and extends when the stored deadline matches', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const collection = new MemoryCollection();
    const provider = new ArangoDbLockProvider(collection.asCollection(), database());
    const lock = await provider.lock(createLockConfig('job', 60_000, 5_000));
    expect(lock).toBeDefined();
    const acquiredRev = collection.docs.get('job')?._rev;

    await lock?.unlock();
    expect(collection.docs.get('job')?.lockUntil).toBe('1970-01-01T00:16:45.000Z');
    expect(collection.updates[0]?.ifMatch).toBe(acquiredRev);

    now = 1_006_000;
    const again = await provider.lock(createLockConfig('job', 60_000));
    expect(again).toBeDefined();
    const extendRev = collection.docs.get('job')?._rev;
    const extended = await again?.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(collection.docs.get('job')?.lockUntil).toBe(Utils.toIsoString(1_126_000));
    expect(collection.updates.at(-1)?.ifMatch).toBe(extendRev);
  });

  it('extend does not write when the previous deadline is missing', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    ClockProvider.setClock(() => 1_000_000);
    const collection = new MemoryCollection();
    await collection.save({
      _key: 'job',
      lockUntil: '2999-01-01T00:00:00.000Z',
      lockedAt: '1970-01-01T00:16:40.000Z',
      lockedBy: 'host-a',
    });
    const accessor = new ArangoDbAccessor(collection.asCollection(), database());
    await expect(accessor.extend(createLockConfig('job', 60_000))).resolves.toBeUndefined();
    expect(collection.updates).toHaveLength(0);
    expect(collection.docs.get('job')?.lockUntil).toBe('2999-01-01T00:00:00.000Z');
  });
});
