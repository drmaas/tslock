import { validateIdentifier } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { validateSerialConsistency } from '../../src/validation.js';

describe('validateIdentifier', () => {
  it('accepts valid identifiers', () => {
    expect(() => validateIdentifier('shedlock', 'table')).not.toThrow();
    expect(() => validateIdentifier('my_table', 'table')).not.toThrow();
    expect(() => validateIdentifier('_foo', 'table')).not.toThrow();
    expect(() => validateIdentifier('abc123', 'table')).not.toThrow();
  });

  it('rejects invalid identifiers', () => {
    expect(() => validateIdentifier('invalid-name', 'table')).toThrow();
    expect(() => validateIdentifier('', 'table')).toThrow();
    expect(() => validateIdentifier('1bad', 'table')).toThrow();
    expect(() => validateIdentifier('with space', 'table')).toThrow();
  });
});

describe('validateSerialConsistency', () => {
  it('accepts SERIAL and LOCAL_SERIAL', () => {
    expect(() => validateSerialConsistency(8)).not.toThrow();
    expect(() => validateSerialConsistency(9)).not.toThrow();
  });

  it('rejects other levels', () => {
    expect(() => validateSerialConsistency(6)).toThrow();
  });
});
