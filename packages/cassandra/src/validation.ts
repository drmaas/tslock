import { LockException } from '@tslock/core';

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const SERIAL = 8;
const LOCAL_SERIAL = 9;

export function validateIdentifier(value: string, label: string): void {
  if (!value || !IDENTIFIER_RE.test(value)) {
    throw new LockException(`Invalid ${label}: "${value}". Must match ${String(IDENTIFIER_RE)}`);
  }
}

export function validateSerialConsistency(level: number): void {
  if (level !== SERIAL && level !== LOCAL_SERIAL) {
    throw new LockException(`serialConsistencyLevel must be SERIAL or LOCAL_SERIAL for LWT, got ${level}`);
  }
}
