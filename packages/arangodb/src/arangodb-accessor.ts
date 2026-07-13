import { ClockProvider, type LockConfiguration, lockAtMostUntil, Utils, unlockTime } from '@tslock/core';
import type { DocumentCollection, EdgeCollection } from 'arangojs/collection';
import type { Database } from 'arangojs/database';
import { ArangoDbLock } from './arangodb-lock.js';
import type { ArangoDbLockDocument } from './arangodb-lock-document.js';

type ArangoCollection<T extends Record<string, any>> = DocumentCollection<T> & EdgeCollection<T>;

function isDocumentNotFoundError(e: unknown): boolean {
  const err = e as Record<string, unknown> | null | undefined;
  return err?.errorNum === 1202 || err?.code === 1202;
}

function isConflictError(e: unknown): boolean {
  const err = e as Record<string, unknown> | null | undefined;
  return err?.errorNum === 1200 || err?.code === 1200;
}

export class ArangoDbAccessor {
  constructor(
    private readonly collection: ArangoCollection<ArangoDbLockDocument>,
    private readonly database: Database,
  ) {}

  async lock(config: LockConfiguration): Promise<ArangoDbLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const collectionName = this.collection.name;
    const documentId = config.name;

    const txn = await this.database.beginTransaction({
      exclusive: [collectionName],
    });

    try {
      let existing: ArangoDbLockDocument | null;
      try {
        existing = await txn.step(() => this.collection.document(documentId));
      } catch (e) {
        if (isDocumentNotFoundError(e)) {
          existing = null;
        } else {
          await txn.abort();
          throw e;
        }
      }

      if (existing === null) {
        await txn.step(() =>
          this.collection.save({
            _key: documentId,
            lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
            lockedAt: Utils.toIsoString(now),
            lockedBy: hostname,
          }),
        );
        await txn.commit();
        return new ArangoDbLock(config, this);
      }

      const lockUntilMillis = Date.parse(existing.lockUntil);
      if (lockUntilMillis <= now) {
        await txn.step(() =>
          this.collection.update(documentId, {
            lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
            lockedAt: Utils.toIsoString(now),
            lockedBy: hostname,
          }),
        );
        await txn.commit();
        return new ArangoDbLock(config, this);
      }

      await txn.abort();
      return undefined;
    } catch (e) {
      try {
        await txn.abort();
      } catch {}
      throw e;
    }
  }

  async extend(config: LockConfiguration): Promise<ArangoDbLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const documentId = config.name;

    let existing: ArangoDbLockDocument;
    try {
      existing = await this.collection.document(documentId);
    } catch (e) {
      if (isDocumentNotFoundError(e)) return undefined;
      throw e;
    }

    if (existing.lockedBy !== hostname) return undefined;
    if (Date.parse(existing.lockUntil) <= now) return undefined;

    const rev = (existing as unknown as Record<string, unknown>)._rev as string | undefined;
    try {
      await this.collection.update(
        documentId,
        { lockUntil: Utils.toIsoString(lockAtMostUntil(config)) },
        rev ? { ifMatch: rev } : undefined,
      );
    } catch (e) {
      if (rev && isConflictError(e)) return undefined;
      throw e;
    }

    return new ArangoDbLock(config, this);
  }

  async unlock(config: LockConfiguration): Promise<void> {
    try {
      await this.collection.update(config.name, {
        lockUntil: Utils.toIsoString(unlockTime(config)),
      });
    } catch (e) {
      if (isDocumentNotFoundError(e)) return;
      throw e;
    }
  }
}
