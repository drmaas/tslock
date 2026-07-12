export interface MongoLockDocument {
  _id: string;
  lockUntil: Date;
  lockedAt: Date;
  lockedBy: string;
}
