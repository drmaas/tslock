import { LockException, Utils } from '@tslock/core';

export interface CloudFrontKvsLockRecord {
  lockUntil: string;
  lockedAt: string;
  lockedBy: string;
}

export function encodeLockRecord(record: CloudFrontKvsLockRecord): string {
  return JSON.stringify(record);
}

export function decodeLockRecord(value: string): CloudFrontKvsLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LockException('Corrupted lock record: invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new LockException('Corrupted lock record: expected object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.lockUntil !== 'string' || typeof obj.lockedAt !== 'string' || typeof obj.lockedBy !== 'string') {
    throw new LockException('Corrupted lock record: missing lockUntil, lockedAt, or lockedBy');
  }
  if (Number.isNaN(Date.parse(obj.lockUntil)) || Number.isNaN(Date.parse(obj.lockedAt))) {
    throw new LockException('Corrupted lock record: unparseable timestamps');
  }
  return {
    lockUntil: obj.lockUntil,
    lockedAt: obj.lockedAt,
    lockedBy: obj.lockedBy,
  };
}

export function buildLockRecord(lockUntilMs: number, lockedAtMs: number, lockedBy: string): CloudFrontKvsLockRecord {
  return {
    lockUntil: Utils.toIsoString(lockUntilMs),
    lockedAt: Utils.toIsoString(lockedAtMs),
    lockedBy,
  };
}

export function parseLockUntilMs(record: CloudFrontKvsLockRecord): number {
  return Date.parse(record.lockUntil);
}
