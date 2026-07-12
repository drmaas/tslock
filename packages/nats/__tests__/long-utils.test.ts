import { describe, expect, it } from 'vitest';
import { longToBytes, bytesToLong } from '../src/long-utils.js';

describe('longToBytes / bytesToLong', () => {
  it('longToBytes(0) returns 8 zero bytes', () => {
    expect(longToBytes(0)).toEqual(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]));
  });

  it('longToBytes writes big-endian', () => {
    const buf = longToBytes(1);
    expect(buf).toEqual(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]));
  });

  it('round-trip for various values', () => {
    for (const val of [0, 1, 1e12, 1.7e12, Date.now()]) {
      expect(bytesToLong(longToBytes(val))).toBe(val);
    }
  });

  it('bytesToLong(Buffer.from([0,0,0,0,0,0,0,1])) returns 1', () => {
    expect(bytesToLong(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(1);
  });

  it('bytesToLong accepts Uint8Array input', () => {
    const arr = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]);
    expect(bytesToLong(arr)).toBe(42);
  });

  it('longToBytes(1544185837810) returns expected buffer', () => {
    const buf = longToBytes(1544185837810);
    expect(Number(buf.readBigInt64BE(0))).toBe(1544185837810);
  });
});
