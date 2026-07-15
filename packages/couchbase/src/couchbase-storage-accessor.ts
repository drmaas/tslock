import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  Utils,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';
import type { Collection, GetResult } from 'couchbase';
import { CasMismatchError, DocumentExistsError, DocumentNotFoundError } from 'couchbase';
import type { ResolvedOptions } from './couchbase-lock-provider.js';
import { buildDocumentId } from './document-id.js';

export class CouchbaseStorageAccessor extends AbstractStorageAccessor {
  private readonly lockedByValue: string;

  constructor(
    private readonly collection: Collection,
    private readonly opts: ResolvedOptions,
  ) {
    super();
    this.lockedByValue = opts.lockedByValue;
    if (this.lockedByValue === 'unknown') {
      this.lockedByValue = Utils.getHostname();
    }
  }

  private docId(name: string): string {
    return buildDocumentId(name, { documentIdPrefix: this.opts.documentIdPrefix });
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    try {
      await this.collection.insert(this.docId(config.name), {
        [this.opts.nameCol]: config.name,
        [this.opts.lockUntilCol]: lockAtMostUntil(config),
        [this.opts.lockedAtCol]: ClockProvider.now(),
        [this.opts.lockedByCol]: this.lockedByValue,
      });
      return true;
    } catch (e) {
      if (e instanceof DocumentExistsError) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    let getResult: GetResult;
    try {
      getResult = await this.collection.get(this.docId(config.name));
    } catch (e) {
      if (e instanceof DocumentNotFoundError) throw e;
      throw e;
    }
    const existing = getResult.content as Record<string, unknown>;
    if ((existing[this.opts.lockUntilCol] as number) > ClockProvider.now()) {
      return false;
    }
    try {
      await this.collection.replace(
        this.docId(config.name),
        {
          [this.opts.nameCol]: config.name,
          [this.opts.lockUntilCol]: lockAtMostUntil(config),
          [this.opts.lockedAtCol]: ClockProvider.now(),
          [this.opts.lockedByCol]: this.lockedByValue,
        },
        { cas: getResult.cas },
      );
      return true;
    } catch (e) {
      if (e instanceof CasMismatchError) return false;
      throw e;
    }
  }

  async unlock(config: LockConfiguration): Promise<void> {
    let getResult: GetResult;
    try {
      getResult = await this.collection.get(this.docId(config.name));
    } catch (e) {
      if (e instanceof DocumentNotFoundError) return;
      throw e;
    }
    const existing = getResult.content as Record<string, unknown>;
    try {
      await this.collection.replace(
        this.docId(config.name),
        {
          ...existing,
          [this.opts.lockUntilCol]: unlockTime(config),
        },
        { cas: getResult.cas },
      );
    } catch (e) {
      if (e instanceof CasMismatchError) return;
      throw e;
    }
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    let getResult: GetResult;
    try {
      getResult = await this.collection.get(this.docId(config.name));
    } catch (e) {
      if (e instanceof DocumentNotFoundError) return false;
      throw e;
    }
    const existing = getResult.content as Record<string, unknown>;
    if (existing[this.opts.lockedByCol] !== this.lockedByValue) return false;
    if ((existing[this.opts.lockUntilCol] as number) <= ClockProvider.now()) return false;
    try {
      await this.collection.replace(
        this.docId(config.name),
        {
          ...existing,
          [this.opts.lockUntilCol]: lockAtMostUntil(config),
        },
        { cas: getResult.cas },
      );
      return true;
    } catch (e) {
      if (e instanceof CasMismatchError) return false;
      throw e;
    }
  }
}
