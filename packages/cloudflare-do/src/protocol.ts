export interface DoLockRecord {
  lockUntil: number;
  lockedAt: number;
  lockedBy: string;
  token?: string;
  lockAtLeastUntil?: number;
}

export type LockOp =
  | {
      op: 'lock';
      name: string;
      lockAtMostFor: number;
      lockAtLeastFor: number;
      createdAt: number;
      lockedBy: string;
      token: string;
    }
  | {
      op: 'unlock';
      name: string;
      lockAtMostFor: number;
      lockAtLeastFor: number;
      createdAt: number;
      lockedBy: string;
      token: string;
    }
  | {
      op: 'extend';
      name: string;
      lockAtMostFor: number;
      lockAtLeastFor: number;
      createdAt: number;
      lockedBy: string;
      token: string;
    };

export type LockOpResult =
  | { ok: true; acquired?: boolean; extended?: boolean; token?: string }
  | { ok: false; reason: 'held' | 'not_owner' | 'expired' | 'missing' };
