import { createLockConfig } from '@tslock/core';
import { withMutableClock } from '@tslock/test-support';
import type { Collection, Document } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import type { MongoLockDocument } from '../src/mongo-lock-document.js';
import { MongoLockProvider } from '../src/mongo-lock-provider.js';

type LockFilter = {
  _id: string;
  lockedBy?: string;
  lockUntil?: Date | { $lte?: Date; $gt?: Date };
};

function millis(value: Date): number {
  return Math.trunc(value.getTime());
}

function copy(doc: MongoLockDocument): MongoLockDocument {
  return {
    _id: doc._id,
    lockUntil: new Date(millis(doc.lockUntil)),
    lockedAt: new Date(millis(doc.lockedAt)),
    lockedBy: doc.lockedBy,
  };
}

class MemoryLockCollection {
  private readonly docs = new Map<string, MongoLockDocument>();

  read(id: string): MongoLockDocument | undefined {
    const doc = this.docs.get(id);
    return doc ? copy(doc) : undefined;
  }

  replace(doc: MongoLockDocument): void {
    this.docs.set(doc._id, copy(doc));
  }

  async findOneAndUpdate(
    filter: LockFilter,
    update: { $set?: Partial<MongoLockDocument> },
    options?: { upsert?: boolean; returnDocument?: 'before' | 'after' },
  ): Promise<MongoLockDocument | null> {
    const existing = this.docs.get(filter._id);
    if (existing && matches(existing, filter)) {
      const next = applySet(existing, update.$set);
      this.docs.set(filter._id, next);
      return options?.returnDocument === 'before' ? copy(existing) : copy(next);
    }
    if (!options?.upsert) return null;
    if (existing) {
      throw new MongoServerError({ message: 'E11000 duplicate key', code: 11000 } as unknown as Document);
    }
    const inserted = applySet(
      { _id: filter._id, lockUntil: new Date(0), lockedAt: new Date(0), lockedBy: '' },
      update.$set,
    );
    this.docs.set(filter._id, inserted);
    return copy(inserted);
  }

  asCollection(): Collection<MongoLockDocument> {
    return this as unknown as Collection<MongoLockDocument>;
  }
}

function matches(doc: MongoLockDocument, filter: LockFilter): boolean {
  if (doc._id !== filter._id) return false;
  if (filter.lockedBy !== undefined && doc.lockedBy !== filter.lockedBy) return false;
  const until = filter.lockUntil;
  if (until instanceof Date) return millis(doc.lockUntil) === millis(until);
  if (until?.$lte && millis(doc.lockUntil) > millis(until.$lte)) return false;
  if (until?.$gt && millis(doc.lockUntil) <= millis(until.$gt)) return false;
  return true;
}

function applySet(doc: MongoLockDocument, set: Partial<MongoLockDocument> | undefined): MongoLockDocument {
  return copy({ ...doc, ...set });
}

function providerFor(collection: MemoryLockCollection): MongoLockProvider {
  return new MongoLockProvider(collection.asCollection());
}

describe('Mongo same-host ownership', () => {
  it('does not unlock a newer lock acquired by the same host', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const collection = new MemoryLockCollection();
      const provider = providerFor(collection);
      const first = await provider.lock(createLockConfig('job', 5_000));
      expect(first).toBeDefined();
      clock.advance(5_001);
      const second = await provider.lock(createLockConfig('job', 60_000));
      expect(second).toBeDefined();
      const heldUntil = collection.read('job')?.lockUntil.getTime();

      await first?.unlock();

      expect(collection.read('job')?.lockUntil.getTime()).toBe(heldUntil);
      expect(await provider.lock(createLockConfig('job', 60_000))).toBeUndefined();
      await second?.unlock();
      expect(await provider.lock(createLockConfig('job', 60_000))).toBeDefined();
    });
  });

  it('does not extend a newer lock acquired by the same host', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const collection = new MemoryLockCollection();
      const provider = providerFor(collection);
      const updates = vi.spyOn(collection, 'findOneAndUpdate');
      const first = await provider.lock(createLockConfig('job', 5_000));
      expect(first).toBeDefined();
      clock.advance(5_001);
      const second = await provider.lock(createLockConfig('job', 60_000));
      expect(second).toBeDefined();
      const heldUntil = collection.read('job')?.lockUntil.getTime();
      const callsAfterAcquire = updates.mock.calls.length;

      expect(await first?.extend(60_000, 0)).toBeUndefined();

      expect(updates.mock.calls.length).toBe(callsAfterAcquire);
      expect(collection.read('job')?.lockUntil.getTime()).toBe(heldUntil);
    });
  });

  it('moves lockUntil to unlockTime before expiry', async () => {
    await withMutableClock(1_000_000, async () => {
      const collection = new MemoryLockCollection();
      const provider = providerFor(collection);
      const lock = await provider.lock(createLockConfig('job', 60_000, 5_000));
      expect(lock).toBeDefined();
      await lock?.unlock();
      expect(collection.read('job')?.lockUntil.getTime()).toBe(1_005_000);
    });
  });

  it('does not update a document locked by a different host', async () => {
    await withMutableClock(1_000_000, async () => {
      const collection = new MemoryLockCollection();
      const provider = providerFor(collection);
      const lock = await provider.lock(createLockConfig('job', 60_000));
      expect(lock).toBeDefined();
      const stored = collection.read('job');
      expect(stored).toBeDefined();
      collection.replace({ ...stored!, lockedBy: 'other-host' });
      await lock?.unlock();
      expect(collection.read('job')).toEqual({ ...stored!, lockedBy: 'other-host' });
    });
  });

  it('extends while this deadline is still stored', async () => {
    await withMutableClock(1_000_000, async () => {
      const collection = new MemoryLockCollection();
      const provider = providerFor(collection);
      const lock = await provider.lock(createLockConfig('job', 60_000));
      expect(lock).toBeDefined();
      const extended = await lock?.extend(120_000, 0);
      expect(extended).toBeDefined();
      expect(collection.read('job')?.lockUntil.getTime()).toBe(1_120_000);
      await extended?.unlock();
      expect(collection.read('job')?.lockUntil.getTime()).toBe(1_000_000);
    });
  });
});
