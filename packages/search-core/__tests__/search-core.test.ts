import { describe, expect, it } from 'vitest';
import {
  EXTEND_SCRIPT,
  FieldNames,
  isConflictError,
  isNotFoundError,
  LOCK_SCRIPT,
  UNLOCK_SCRIPT,
} from '../src/index.js';

describe('scripts', () => {
  it('LOCK_SCRIPT updates when expired and sets none otherwise', () => {
    expect(LOCK_SCRIPT).toContain('ctx._source[params.lockUntilField] <= params.now');
    expect(LOCK_SCRIPT).toContain("ctx.op = 'none'");
  });

  it('UNLOCK_SCRIPT sets lockUntil to unlockTime', () => {
    expect(UNLOCK_SCRIPT).toBe('ctx._source[params.lockUntilField] = params.unlockTime');
  });

  it('EXTEND_SCRIPT requires lockedBy and active lockUntil', () => {
    expect(EXTEND_SCRIPT).toContain(
      'ctx._source[params.lockedByField] == params.lockedBy && ctx._source[params.lockUntilField] > params.now',
    );
    expect(EXTEND_SCRIPT).toContain("ctx.op = 'none'");
  });
});

describe('FieldNames', () => {
  it('exposes DEFAULT and SNAKE_CASE presets', () => {
    expect(FieldNames.DEFAULT).toEqual({
      lockUntil: 'lockUntil',
      lockedAt: 'lockedAt',
      lockedBy: 'lockedBy',
    });
    expect(FieldNames.SNAKE_CASE).toEqual({
      lockUntil: 'lock_until',
      lockedAt: 'locked_at',
      lockedBy: 'locked_by',
    });
  });
});

describe('http status helpers', () => {
  it('isConflictError detects 409 via meta.statusCode or statusCode', () => {
    expect(isConflictError({ meta: { statusCode: 409 } })).toBe(true);
    expect(isConflictError({ statusCode: 409 })).toBe(true);
    expect(isConflictError({ meta: { statusCode: 500 } })).toBe(false);
    expect(isConflictError(null)).toBe(false);
  });

  it('isNotFoundError detects 404 via meta.statusCode or statusCode', () => {
    expect(isNotFoundError({ meta: { statusCode: 404 } })).toBe(true);
    expect(isNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isNotFoundError({ meta: { statusCode: 500 } })).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});
