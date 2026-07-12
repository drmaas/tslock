import { describe, expect, it } from 'vitest';
import { validateIdentifier, validateSerialConsistency } from '../../src/validation.js';

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
  it('accepts SERIAL (8) and LOCAL_SERIAL (9)', () => {
    expect(() => validateSerialConsistency(8)).not.toThrow();
    expect(() => validateSerialConsistency(9)).not.toThrow();
  });

  it('rejects non-serial consistency levels', () => {
    expect(() => validateSerialConsistency(6)).toThrow();
    expect(() => validateSerialConsistency(1)).toThrow();
    expect(() => validateSerialConsistency(0)).toThrow();
  });
});
