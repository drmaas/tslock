import { LockException } from '@tslock/core';

const SERIAL = 8;
const LOCAL_SERIAL = 9;

export function validateSerialConsistency(level: number): void {
  if (level !== SERIAL && level !== LOCAL_SERIAL) {
    throw new LockException(`serialConsistencyLevel must be SERIAL or LOCAL_SERIAL for LWT, got ${level}`);
  }
}
