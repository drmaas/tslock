import { LockException } from '@tslock/core';

export interface KvLockRecord {
  lockUntil: number;
  lockedAt: number;
  lockedBy: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function encodeLockRecord(record: KvLockRecord): string {
  return JSON.stringify(record);
}

export function decodeLockRecord(raw: string): KvLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new LockException('Cloudflare KV lock record is not valid JSON', { cause });
  }
  if (!isRecord(parsed)) {
    throw new LockException('Cloudflare KV lock record is malformed');
  }
  const { lockUntil, lockedAt, lockedBy, token } = parsed;
  if (
    !isFiniteNumber(lockUntil) ||
    !isFiniteNumber(lockedAt) ||
    typeof lockedBy !== 'string' ||
    lockedBy.length === 0 ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    throw new LockException('Cloudflare KV lock record is malformed');
  }
  return { lockUntil, lockedAt, lockedBy, token };
}
