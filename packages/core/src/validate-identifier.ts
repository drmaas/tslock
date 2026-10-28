import { LockException } from './lock-exception.js';

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateIdentifier(value: string, label: string): void {
  if (!value || !IDENTIFIER_RE.test(value)) {
    throw new LockException(`Invalid ${label}: "${value}". Must match ${String(IDENTIFIER_RE)}`);
  }
}
