import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { Neo4jLockProvider, resolveOptions } from '../src/neo4j-lock-provider.js';

describe('resolveOptions', () => {
  it('returns defaults when no options provided', () => {
    const opts = resolveOptions();
    expect(opts.label).toBe('ShedLock');
    expect(opts.nameCol).toBe('name');
    expect(opts.lockUntilCol).toBe('lockUntil');
    expect(opts.lockedAtCol).toBe('lockedAt');
    expect(opts.lockedByCol).toBe('lockedBy');
  });

  it('applies partial options over defaults', () => {
    const opts = resolveOptions({ columnNames: { lockUntil: 'expires' } });
    expect(opts.label).toBe('ShedLock');
    expect(opts.lockUntilCol).toBe('expires');
    expect(opts.nameCol).toBe('name');
  });

  it('throws on invalid label', () => {
    expect(() => resolveOptions({ label: 'bad-label!' })).toThrow('not a valid Neo4j identifier');
  });

  it('throws on invalid column name', () => {
    expect(() => resolveOptions({ columnNames: { name: 'bad name' } })).toThrow('not a valid Neo4j identifier');
  });

  it('throws on empty label', () => {
    expect(() => resolveOptions({ label: '' })).toThrow('not a valid Neo4j identifier');
  });
});

describe('Neo4jLockProvider', () => {
  it('constructs with a mocked driver', () => {
    const driver = {} as unknown as Driver;
    const provider = new Neo4jLockProvider(driver);
    expect(provider).toBeInstanceOf(Neo4jLockProvider);
  });

  it('constructs with options', () => {
    const driver = {} as unknown as Driver;
    const provider = new Neo4jLockProvider(driver, { label: 'CustomLock' });
    expect(provider).toBeInstanceOf(Neo4jLockProvider);
  });
});
