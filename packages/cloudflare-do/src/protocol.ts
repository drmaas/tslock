export interface DoLockRecord {
  lockUntil: number;
  lockedAt: number;
  lockedBy: string;
}

export type LockOp =
  | {
      op: 'lock';
      name: string;
      lockAtMostFor: number;
      lockAtLeastFor: number;
      createdAt: number;
      lockedBy: string;
    }
  | {
      op: 'unlock';
      name: string;
      lockAtMostFor: number;
      lockAtLeastFor: number;
      createdAt: number;
      lockedBy: string;
    }
  | {
      op: 'extend';
      name: string;
      lockAtMostFor: number;
      lockAtLeastFor: number;
      createdAt: number;
      lockedBy: string;
    };

export type LockOpResult =
  | { ok: true; acquired?: boolean; extended?: boolean }
  | { ok: false; reason: 'held' | 'not_owner' | 'expired' | 'missing' };
