import type { Collection } from 'couchbase';
import { describe, expect, it } from 'vitest';
import { CouchbaseLockProvider } from '../src/couchbase-lock-provider.js';

describe('CouchbaseLockProvider', () => {
  it('constructs with a mocked collection', () => {
    const collection = {} as unknown as Collection;
    const provider = new CouchbaseLockProvider(collection);
    expect(provider).toBeInstanceOf(CouchbaseLockProvider);
  });

  it('constructs with options', () => {
    const collection = {} as unknown as Collection;
    const provider = new CouchbaseLockProvider(collection, { documentIdPrefix: 'lock:' });
    expect(provider).toBeInstanceOf(CouchbaseLockProvider);
  });
});
