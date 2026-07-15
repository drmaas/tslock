export interface ArangoDbLockDocument {
  [key: string]: unknown;
  _key: string;
  lockUntil: string;
  lockedAt: string;
  lockedBy: string;
}
