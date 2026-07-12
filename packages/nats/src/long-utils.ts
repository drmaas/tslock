export function longToBytes(epochMillis: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(epochMillis), 0);
  return buf;
}

export function bytesToLong(buf: Uint8Array): number {
  return Number(Buffer.from(buf).readBigInt64BE(0));
}
