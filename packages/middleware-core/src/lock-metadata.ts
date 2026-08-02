export interface LockMetadata {
  lockName: string;
  lockedBy: string;
  lockUntil: number;
  retryAfterSeconds: number;
}

export type StaticLockedBody = string | number | boolean | null | Record<string, unknown> | unknown[];

export type LockedBody = StaticLockedBody | ((meta: LockMetadata) => unknown);

export interface LockFailureResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export function buildLockFailureResponse(
  status: number,
  body: unknown,
  lockName: string,
  lockedBy: string,
  lockUntil: number,
): LockFailureResponse {
  const now = Date.now();
  const retryAfterSeconds = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  return {
    status,
    body: typeof body === 'function' ? body({ lockName, lockedBy, lockUntil, retryAfterSeconds }) : body,
    headers: {
      'Retry-After': String(retryAfterSeconds),
      'Lock-Name': lockName,
      'Locked-By': lockedBy,
    },
  };
}

export function defaultLockedBody(meta: LockMetadata): Record<string, unknown> {
  return {
    error: 'Resource locked by another instance',
    lockName: meta.lockName,
    lockedBy: meta.lockedBy,
    retryAfterSeconds: meta.retryAfterSeconds,
  };
}
