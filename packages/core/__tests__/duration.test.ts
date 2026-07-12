import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/duration.js';
import { LockException } from '../src/lock-exception.js';

describe('parseDuration', () => {
  it('parses number as millis', () => {
    expect(parseDuration(30000)).toBe(30000);
    expect(parseDuration(0)).toBe(0);
  });

  it('parses string with ms unit', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('parses string with s unit', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('parses string with m unit', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses string with h unit', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('parses string with d unit', () => {
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('parses bare number string as millis', () => {
    expect(parseDuration('250')).toBe(250);
  });

  it('parses duration object', () => {
    expect(parseDuration({ hours: 1, minutes: 30 })).toBe(5_400_000);
    expect(parseDuration({ seconds: 30 })).toBe(30_000);
    expect(parseDuration({ millis: 500 })).toBe(500);
    expect(parseDuration({})).toBe(0);
  });

  it('throws on unparseable string', () => {
    expect(() => parseDuration('abc')).toThrow(LockException);
    expect(() => parseDuration('5x')).toThrow(LockException);
    expect(() => parseDuration('')).toThrow(LockException);
  });

  it('throws on negative number', () => {
    expect(() => parseDuration(-1)).toThrow(LockException);
  });
});
