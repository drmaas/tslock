import { describe, expect, it } from 'vitest';
import { LockException } from '../src/lock-exception.js';
import { validateIdentifier } from '../src/validate-identifier.js';

describe('validateIdentifier', () => {
  it('accepts valid identifiers', () => {
    expect(() => validateIdentifier('shedlock', 'tableName')).not.toThrow();
    expect(() => validateIdentifier('my_locks', 'tableName')).not.toThrow();
    expect(() => validateIdentifier('_foo', 'tableName')).not.toThrow();
    expect(() => validateIdentifier('expires_at', 'columnNames.lockUntil')).not.toThrow();
    expect(() => validateIdentifier('abc123', 'tableName')).not.toThrow();
  });

  it('rejects invalid identifiers', () => {
    expect(() => validateIdentifier('shedlock;drop', 'tableName')).toThrow(LockException);
    expect(() => validateIdentifier('a b', 'tableName')).toThrow(LockException);
    expect(() => validateIdentifier('1bad', 'tableName')).toThrow(LockException);
    expect(() => validateIdentifier('', 'tableName')).toThrow(LockException);
    expect(() => validateIdentifier('invalid-name', 'tableName')).toThrow(LockException);
    expect(() => validateIdentifier("lockedBy = 'x' OR 1=1 --", 'columnNames.lockedBy')).toThrow(LockException);
  });
});
