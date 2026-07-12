export interface ArangoDbLockDocument {
  _key: string;
  lockUntil: string;
  lockedAt: string;
  lockedBy: string;
}
